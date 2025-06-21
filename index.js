const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');
const cors = require('cors')({ origin: true });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

async function getDriveFileContent(drive, fileId, mimeType, fileName) {
    console.log(`[DEBUG] Attempting to read file: ${fileName} (ID: ${fileId}, Type: ${mimeType})`);
    
    if (mimeType === 'application/vnd.google-apps.document' || mimeType.startsWith('text/')) {
        const exportMimeType = (mimeType === 'application/vnd.google-apps.document') ? 'text/plain' : mimeType;
        try {
            const res = await drive.files.export({ fileId, mimeType: exportMimeType }, { responseType: 'stream' });
            return new Promise((resolve, reject) => {
                let buf = '';
                res.data.on('data', (chunk) => buf += chunk);
                res.data.on('end', () => {
                    console.log(`[DEBUG] Successfully read content from: ${fileName}`);
                    resolve(buf);
                });
                res.data.on('error', (err) => reject(err));
            });
        } catch (exportError) {
            console.error(`[DEBUG] Export failed for ${fileName}. Error: ${exportError.message}. Trying fallback...`);
            try {
                 const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
                 return new Promise((resolve, reject) => {
                    let buf = '';
                    res.data.on('data', (chunk) => buf += chunk);
                    res.data.on('end', () => {
                        console.log(`[DEBUG] Successfully read content from '${fileName}' using fallback.`);
                        resolve(buf);
                    });
                    res.data.on('error', (err) => reject(err));
                });
            } catch(fallbackError) {
                console.error(`[DEBUG] Fallback failed for ${fileName}. Error: ${fallbackError.message}.`);
                return '';
            }
        }
    }
    else {
        console.log(`[DEBUG] Skipping unsupported file type: ${mimeType} for file: ${fileName}`);
        return '';
    }
}

exports.ask = (req, res) => {
  cors(req, res, async () => {
    const { type, prompt, accessToken, code } = req.body;

    try {
      const oauth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET
      );
      oauth2Client.setCredentials({ access_token: accessToken });

      if (type === 'gemini') {
        if (!prompt || !accessToken) {
          return res.status(400).send({ error: 'A prompt and access token are required.' });
        }
        
        let context = '';
        const drive = google.drive({ version: 'v3', auth: oauth2Client });
        const folderResponse = await drive.files.list({
            q: "name='PeachTreeFiles' and mimeType='application/vnd.google-apps.folder' and trashed=false",
            fields: 'files(id)', pageSize: 1
        });

        if (folderResponse.data.files && folderResponse.data.files.length > 0) {
            const folderId = folderResponse.data.files[0].id;
            const filesResponse = await drive.files.list({
                q: `'${folderId}' in parents and trashed=false`,
                fields: 'files(id, name, mimeType)'
            });
            
            if (filesResponse.data.files && filesResponse.data.files.length > 0) {
                const contentPromises = filesResponse.data.files.map(file => 
                    getDriveFileContent(drive, file.id, file.mimeType, file.name).catch(e => '')
                );
                const allContents = await Promise.all(contentPromises);
                context = allContents.filter(c => c).join('\n\n---\n\n');
            }
        }

        const enhancedPrompt = `Based on the following context, please answer the user's question. If the context does not contain the answer, say so.\n\nCONTEXT:\n---\n${context}\n---\n\nQUESTION: ${prompt}`;
        
        const result = await model.generateContent(enhancedPrompt);
        const geminiResponse = await result.response;
        const answer = geminiResponse.text();
        
        try {
            const userInfo = await google.oauth2('v2').userinfo.get({ auth: oauth2Client });
            const userEmail = userInfo.data.email || 'unknown';
            const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
            const logEntry = [ new Date().toISOString(), userEmail, prompt ];
            await sheets.spreadsheets.values.append({
                spreadsheetId: process.env.SPREADSHEET_ID, range: 'A1', valueInputOption: 'USER_ENTERED', resource: { values: [logEntry] }
            });
        } catch (logError) {
            console.error("Failed to log question to Google Sheet:", logError.message);
        }

        return res.status(200).send({ response: answer });

      } else if (type === 'report') {
        if (!accessToken) return res.status(400).send({ error: 'Access token required.' });
        
        const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.SPREADSHEET_ID,
            range: 'Sheet1!A:C',
        });

        const rows = response.data.values;
        if (!rows || rows.length <= 1) { // Check for header row
            return res.status(200).send({ report: "The log sheet is empty or only contains a header. No report to generate." });
        }
        
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const recentQuestions = rows.slice(1).filter(row => { // Use slice(1) to skip header
            const timestamp = new Date(row[0]);
            return timestamp > sevenDaysAgo;
        }).map(row => `- ${row[2]}`);

        if (recentQuestions.length === 0) {
            return res.status(200).send({ report: "No questions have been asked in the last 7 days." });
        }

        const questionsText = recentQuestions.join('\n');
        const reportPrompt = `As an operations analyst for a Virtual Assistant company, review the following list of questions asked by our VAs over the last week. Generate a brief, professional report for management. The report should identify 2-3 key themes or common areas of confusion, point out potential gaps in our training or documentation, and suggest specific, actionable improvements.\n\nQuestions Asked This Week:\n${questionsText}`;
        
        const result = await model.generateContent(reportPrompt);
        const geminiResponse = await result.response;
        const reportText = geminiResponse.text();
        
        return res.status(200).send({ report: reportText });
      
      } else if (type === 'token') {
        if (!code) { return res.status(400).send({ error: 'A code is required.' }); }
        const oauth2Client_token = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, 'postmessage');
        const { tokens } = await oauth2Client_token.getToken(code);
        return res.status(200).send({ accessToken: tokens.access_token });

      } else {
        return res.status(400).send({ error: 'A valid request type was not provided.' });
      }
    } catch (error) {
      console.error('An error occurred:', error.message);
      return res.status(500).send({ error: 'Something went wrong on the backend.' });
    }
  });
};
