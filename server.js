// server.js - Deploy to Render (The Brain)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' })); 

// --- CONFIG & PLACEHOLDERS (Set in Render Environment Variables) ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const HF_TOKEN = process.env.HF_TOKEN; 
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY; // Required for full YT integration
const BRAVE_API_KEY = process.env.BRAVE_API_KEY; // For Web Search

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const PORT = process.env.PORT || 3000;

// Middleware for JWT Authentication (Ensures single-user)
const authMiddleware = async (req, res, next) => {
    // Client must pass the Supabase JWT (access_token) in the Authorization header
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized: Missing JWT' });
    
    // Server verifies the token and gets user ID
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Unauthorized: Invalid token or user session expired' });
    
    req.user = user; 
    next();
};

// --- API ROUTES ---

// 1. NYX AI CORE (Suggest/Apply Mode)
app.post('/api/nyx/think', authMiddleware, async (req, res) => {
    const { prompt, context, mode, target_table, target_id } = req.body;
    const userId = req.user.id;
    
    // Fetch profile for context and PAUSE check
    const { data: profile } = await supabase.from('profiles').select('active_persona, stats').eq('id', userId).single();
    
    if (profile.active_persona === 'PAUSED' && mode === 'APPLY') {
        return res.status(403).json({ error: "System PAUSED. Cannot APPLY changes." });
    }

    const systemPrompt = `You are NYX, the logic core. Persona: ${profile.active_persona}. 
    Objective: Fulfill the user request. Analyze user context (${JSON.stringify(profile.stats)}) to suggest optimal actions.
    Mode: ${mode}. If APPLY, output a single, clean JSON object { "table": "...", "id": "...", "data": {...} } for database update.
    Output Format: JSON only { "reasoning": "...", "action_type": "...", "payload": "..." }`;

    try {
        const hfResponse = await fetch('https://api-inference.huggingface.co/models/Qwen/Qwen2.5-7B-Instruct', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${HF_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                inputs: `${systemPrompt}\n\nUser Request: ${prompt}`,
                parameters: { max_new_tokens: 1024, temperature: 0.6 }
            })
        });

        const result = await hfResponse.json();
        let aiText = result[0]?.generated_text || "{}";
        let aiPayload = {};

        try {
            // Attempt to parse AI's suggested payload
            const actionMatch = aiText.match(/\{[\s\S]*"payload"[\s\S]*\}/i);
            if (actionMatch) {
                 aiPayload = JSON.parse(actionMatch[0]);
            }
        } catch(e) { /* Ignore non-JSON output */ }


        // 1. Take Snapshot BEFORE action
        let snapshotData = {};
        if (target_table && target_id) {
            const { data } = await supabase.from(target_table).select('*').eq('id', target_id).limit(1).single();
            snapshotData = data;
        }

        // 2. Write Audit Log (Mandatory for all NYX calls)
        const auditLog = {
            user_id: userId,
            action: `${mode}_${target_table || 'GENERAL'}`,
            ai_reasoning: aiPayload.reasoning || aiText,
            snapshot_before: snapshotData,
            snapshot_table_name: target_table,
            snapshot_table_id: target_id || 'N/A'
        };
        await supabase.from('audit_logs').insert(auditLog);

        // 3. APPLY Logic (Server-side execution)
        if (mode === 'APPLY' && aiPayload.data && aiPayload.table) {
            const { error: updateError } = await supabase.from(aiPayload.table).upsert({ 
                ...aiPayload.data, 
                user_id: userId,
                last_modified: new Date().toISOString()
            });
            if (updateError) throw new Error(updateError.message);
        }

        res.json({ result: aiText, mode: mode, executed: mode === 'APPLY' && !updateError });

    } catch (err) {
        console.error("NYX Core Error:", err);
        res.status(500).json({ error: 'NYX Core Failure: ' + err.message });
    }
});

// 2. SCRAPING (Syllabus/YouTube Import)
app.post('/api/scrape', authMiddleware, async (req, res) => {
    const { url, type, courseId } = req.body;
    try {
        if (type === 'youtube_playlist') {
            if (!YOUTUBE_API_KEY) return res.status(500).json({ error: 'YouTube API Key missing in server environment.' });
            
            const playlistIdMatch = url.match(/(?<=list=)[\w-]+/);
            const playlistId = playlistIdMatch ? playlistIdMatch[0] : url;

            let nextPageToken = null;
            let modules = [];
            
            // Fetch playlist items using the YouTube Data API (Full implementation)
            do {
                const api_url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}&key=${YOUTUBE_API_KEY}` + (nextPageToken ? `&pageToken=${nextPageToken}` : '');
                
                const apiRes = await fetch(api_url);
                const apiData = await apiRes.json();
                
                if (apiData.error) throw new Error(apiData.error.message);
                
                apiData.items.forEach((item, index) => {
                    modules.push({ 
                        course_id: courseId,
                        title: item.snippet.title, 
                        youtube_id: item.snippet.resourceId.videoId,
                        week_number: Math.ceil((modules.length + 1) / 5) // Auto-plan 5 items per week
                    });
                });
                nextPageToken = apiData.nextPageToken;
            } while (nextPageToken);

            // Insert modules into Supabase
            const { error: insertError } = await supabase.from('modules').insert(modules);
            if (insertError) throw new Error(insertError.message);

            return res.json({ message: `Successfully imported ${modules.length} modules.`, modules });
        }
        
        // Web Scraping (HTML Headings)
        const response = await fetch(url);
        const html = await response.text();
        const $ = cheerio.load(html);
        
        const modules = [];
        $('h1, h2, h3').each((i, el) => {
            const text = $(el).text().trim();
            if (text.length > 5) {
                modules.push({ 
                    course_id: courseId,
                    title: text, 
                    content_markdown: null,
                    week_number: Math.ceil((i + 1) / 5) 
                });
            }
        });

        // Insert modules into Supabase
        const { error: insertError } = await supabase.from('modules').insert(modules);
        if (insertError) throw new Error(insertError.message);
        
        res.json({ message: `Successfully imported ${modules.length} modules.`, modules, source: url });

    } catch (err) {
        res.status(500).json({ error: 'Scraping failed: ' + err.message });
    }
});

// 3. OFFLINE SYNC API (Last-Write Wins Conflict Resolution)
app.post('/api/sync', authMiddleware, async (req, res) => {
    const { localChanges } = req.body; 
    const userId = req.user.id;
    const results = [];

    for (const change of localChanges) {
        const { table, data } = change;
        
        try {
            // Check Server State
            const { data: serverData, error: fetchError } = await supabase
                .from(table)
                .select('last_modified')
                .eq('id', data.id)
                .limit(1)
                .single();

            let shouldUpdate = true;
            
            // Conflict Check: If server data exists and client is older, skip (Last-Write Wins)
            if (serverData) {
                const serverTime = new Date(serverData.last_modified).getTime();
                const clientTime = new Date(data.last_modified).getTime();
                if (serverTime > clientTime) {
                    shouldUpdate = false;
                    results.push({ table, id: data.id, status: 'conflict_ignored' });
                }
            }

            if (shouldUpdate) {
                const { error: updateError } = await supabase
                    .from(table)
                    .upsert({ ...data, user_id: userId, last_modified: new Date().toISOString() }, { onConflict: 'id' });
                if (updateError) throw new Error(updateError.message);
                results.push({ table, id: data.id, status: 'synced' });
            }
        } catch (e) {
            results.push({ table, id: data.id, status: 'error', error: e.message });
        }
    }

    // Send back any server changes (optional: pull all latest server data here)
    res.json({ status: 'Synchronization Complete', results });
});

app.listen(PORT, () => console.log(`S-OS Cortex Active on ${PORT}`));
