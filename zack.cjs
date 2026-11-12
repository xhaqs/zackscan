const fs = require('fs');
const https = require('https');
const readline = require('readline');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("❌ Error: GEMINI_API_KEY is not set. Run: export GEMINI_API_KEY='your-key'");
  process.exit(1);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log("⚡ Zack CLI [Steroids Mode: Gemini 3.8 Flash + Live Timer active]");
console.log("Type your prompt, ask questions, or type 'exit' to quit.\n");

function promptUser() {
  rl.question('zack(3.8)> ', async (input) => {
    if (!input || input.trim() === 'exit') {
      console.log('Goodbye!');
      rl.close();
      process.exit(0);
    }

    await runZackAgent(input.trim());
    console.log('');
    promptUser();
  });
}

async function runZackAgent(instruction) {
  const files = fs.readdirSync('.').filter(f => /\.(js|html|css|json|md)$/.test(f) && f !== 'zack.cjs' && !f.includes('lock'));
  const context = files.map(f => `--- FILE: ${f} ---\n` + fs.readFileSync(f, 'utf8')).join('\n\n');

  console.log(`🤖 Analyzing ${files.length} files with Gemini 3.8 Flash (Thinking enabled)...`);
  
  // Start the live execution timer
  const startTime = Date.now();
  const timerInterval = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stdout.write(`\r⏱️ Elapsed time: ${elapsed}s...   `);
  }, 500);

  const data = JSON.stringify({
    contents: [{
      parts: [{
        text: `You are Zack, an expert autonomous software engineering agent running locally in Termux.
The user is building Zackscan solo on Android.
Analyze the user's request. If they are asking a question or requesting a code explanation, provide a clear, detailed markdown response. 
If they want code changes, return a JSON block in this exact format:
{
  "files": [
    { "path": "filename", "content": "full updated file content" }
  ],
  "explanation": "Brief summary of changes"
}
If no files need changing, just reply with normal text answering the query.

CODEBASE:
${context}

USER REQUEST: ${instruction}`
      }]
    }],
    generationConfig: {
      thinking_config: {
        thinking_level: "medium"
      }
    }
  });

  await makeApiCall(data, timerInterval, startTime);
}

function makeApiCall(data, timerInterval, startTime, retries = 3) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        clearInterval(timerInterval);
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        process.stdout.write(`\r✨ Completed in ${duration}s                  \n\n`);

        if (res.statusCode === 503 && retries > 0) {
          console.log(`⚠️ Model busy (503). Retrying... (${retries} left)`);
          setTimeout(async () => {
            await makeApiCall(data, timerInterval, startTime, retries - 1);
            resolve();
          }, 2000);
          return;
        }

        try {
          const parsed = JSON.parse(body);
          if (parsed.error) {
            console.error("❌ API Error:", parsed.error.message);
            resolve();
            return;
          }

          const parts = parsed.candidates[0].content.parts;
          const fullText = parts.map(p => p.text || '').join('');

          if (fullText.includes('"files":')) {
            let cleanBody = fullText.replace(/```json/g, '').replace(/```/g, '').trim();
            const firstBrace = cleanBody.indexOf('{');
            const lastBrace = cleanBody.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1) {
              const jsonStr = cleanBody.substring(firstBrace, lastBrace + 1);
              const resJson = JSON.parse(jsonStr);
              
              if (resJson.files && Array.isArray(resJson.files)) {
                resJson.files.forEach(file => {
                  fs.writeFileSync(file.path, file.content, 'utf8');
                  console.log(`✔ Updated file: ${file.path}`);
                });
              }
              console.log(`📝 ${resJson.explanation}`);
              resolve();
              return;
            }
          }

          console.log(fullText);
        } catch (e) {
          console.log(body);
        }
        resolve();
      });
    });

    req.on('error', (err) => {
      clearInterval(timerInterval);
      console.error("\n❌ Network error:", err.message);
      resolve();
    });

    req.write(data);
    req.end();
  });
}

promptUser();
