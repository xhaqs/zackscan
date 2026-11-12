const fs = require('fs');
const https = require('https');

const args = process.argv.slice(2);
const instruction = args.join(' ');
const apiKey = process.env.GEMINI_API_KEY;

if (!instruction || !apiKey) {
  console.log("Usage: node agent.cjs \"<what you want to code or fix>\"");
  process.exit(1);
}

const files = fs.readdirSync('.').filter(f => /\.(js|html|css)$/.test(f) && f !== 'agent.cjs' && !f.includes('lock'));
const context = files.map(f => `--- FILE: ${f} ---\n` + fs.readFileSync(f, 'utf8')).join('\n\n');

console.log(`🤖 Zackscan Agent analyzing ${files.length} files: ${files.join(', ')}...`);

const data = JSON.stringify({
  contents: [{
    parts: [{
      text: `You are an expert autonomous software engineering agent building Zackscan. 
Modify the following codebase based on the user's instruction.
Return ONLY a valid JSON response in this exact format:
{
  "files": [
    { "path": "filename", "content": "full updated file content" }
  ],
  "explanation": "Brief summary of changes"
}

CODEBASE:
${context}

INSTRUCTION: ${instruction}`
    }]
  }]
});

function callGemini(retries = 3) {
  const req = https.request({
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, res => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      if (res.statusCode === 503 && retries > 0) {
        console.log(`⚠️ Model busy (503). Retrying in 2 seconds... (${retries} retries left)`);
        setTimeout(() => callGemini(retries - 1), 2000);
        return;
      }
      try {
        const parsed = JSON.parse(body);
        if (parsed.error) {
          console.error("API Error:", parsed.error.message);
          return;
        }
        
        const parts = parsed.candidates[0].content.parts;
        const fullText = parts.map(p => p.text || '').join('');
        
        let cleanBody = fullText.replace(/```json/g, '').replace(/```/g, '').trim();
        const resJson = JSON.parse(cleanBody);
        
        resJson.files.forEach(file => {
          fs.writeFileSync(file.path, file.content, 'utf8');
          console.log(`✔ Successfully updated: ${file.path}`);
        });
        console.log(`✨ Agent Summary: ${resJson.explanation}`);
      } catch (e) {
        console.error("Agent error parsing response:", e.message);
        console.error("Raw body:", body);
      }
    });
  });
  req.on('error', (err) => {
    console.error("Network error:", err.message);
  });
  req.write(data);
  req.end();
}

callGemini();
