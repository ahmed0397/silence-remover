const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const formidable = require('formidable');
const ffmpeg = require('@ffmpeg-installer/ffmpeg');

const PORT = process.env.PORT || 8080;
// Check if system ffmpeg exists in PATH (e.g. Linux Docker on Render/Railway), else fallback to bundle
let FFMPEG_PATH = 'ffmpeg';
try {
  require('child_process').execSync('ffmpeg -version', { stdio: 'ignore' });
} catch (e) {
  FFMPEG_PATH = ffmpeg.path;
}

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
};

// Helper: Run FFmpeg command and capture output
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Health check endpoint for hosting platforms
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', engine: 'FFmpeg' }));
  }

  // 1. API: Process Silence Removal (Native Server-Side FFmpeg)
  if (req.method === 'POST' && req.url === '/api/process') {
    const form = new formidable.IncomingForm({
      uploadDir: UPLOAD_DIR,
      keepExtensions: true,
      maxFileSize: 1024 * 1024 * 1024, // 1GB
    });

    form.parse(req, async (err, fields, files) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }

      const fileObj = Array.isArray(files.file) ? files.file[0] : files.file;
      if (!fileObj || !fileObj.filepath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'No file uploaded' }));
      }

      const threshold = fields.threshold ? fields.threshold[0] || fields.threshold : '-35';
      const minDuration = fields.duration ? fields.duration[0] || fields.duration : '0.5';
      const padding = parseFloat(fields.padding ? fields.padding[0] || fields.padding : '100') / 1000;

      const inputPath = fileObj.filepath;
      const originalName = fileObj.originalFilename || 'input.mp4';
      const ext = path.extname(originalName) || '.mp4';

      try {
        let targetThreshold = parseFloat(threshold);
        let targetDuration = parseFloat(minDuration);
        let targetPadding = padding;

        if (fields.mode === 'auto' || !fields.threshold) {
          // Automatic mode preset: (Threshold: -30dB, Min Duration: 0.1s, Buffer: 0ms)
          targetThreshold = -30;
          targetDuration = 0.1;
          targetPadding = 0.0;
          console.log(`[Auto Mode] Applying preset: Threshold: ${targetThreshold}dB, Min Duration: ${targetDuration}s, Buffer: 0ms`);
        }

        // Step 1: Detect silence using optimized audio-only pass (-vn ignores heavy video frames)
        const detectRes = await runFFmpeg([
          '-i', inputPath,
          '-vn',
          '-af', `silencedetect=n=${targetThreshold}dB:d=${targetDuration}`,
          '-f', 'null',
          '-'
        ]);

        const fullLog = detectRes.stderr;
        let silenceSegments = [];
        const lines = fullLog.split('\n');
        let currentStart = null;

        for (const line of lines) {
          if (line.includes('silence_start:')) {
            const m = line.match(/silence_start:\s+([\d\.]+)/);
            if (m) currentStart = parseFloat(m[1]);
          } else if (line.includes('silence_end:') || line.includes('silence_duration:')) {
            const m = line.match(/silence_end:\s+([\d\.]+)/);
            if (m && currentStart !== null) {
              const sEnd = parseFloat(m[1]);
              if (sEnd > currentStart) {
                silenceSegments.push({ start: currentStart, end: sEnd });
              }
              currentStart = null;
            }
          }
        }

        // Get file duration from FFmpeg stderr
        let totalDuration = 0;
        const durMatch = fullLog.match(/Duration:\s+(\d+):(\d+):([\d\.]+)/);
        if (durMatch) {
          totalDuration = (parseInt(durMatch[1]) * 3600) + (parseInt(durMatch[2]) * 60) + parseFloat(durMatch[3]);
        }

        if (currentStart !== null && totalDuration > currentStart) {
          silenceSegments.push({ start: currentStart, end: totalDuration });
        }

        // Fallback retry for auto mode if first threshold was too strict/gentle
        if (silenceSegments.length === 0 && (fields.mode === 'auto' || !fields.threshold)) {
          console.log('[Auto Mode] Retrying with aggressive content preset (-30dB, 0.2s)...');
          targetThreshold = -30;
          targetDuration = 0.20;
          const retryRes = await runFFmpeg([
            '-i', inputPath,
            '-vn',
            '-af', `silencedetect=n=${targetThreshold}dB:d=${targetDuration}`,
            '-f', 'null',
            '-'
          ]);

          const retryLines = retryRes.stderr.split('\n');
          let rStart = null;
          for (const line of retryLines) {
            if (line.includes('silence_start:')) {
              const m = line.match(/silence_start:\s+([\d\.]+)/);
              if (m) rStart = parseFloat(m[1]);
            } else if (line.includes('silence_end:') || line.includes('silence_duration:')) {
              const m = line.match(/silence_end:\s+([\d\.]+)/);
              if (m && rStart !== null) {
                silenceSegments.push({ start: rStart, end: parseFloat(m[1]) });
                rStart = null;
              }
            }
          }
          if (rStart !== null && totalDuration > rStart) {
            silenceSegments.push({ start: rStart, end: totalDuration });
          }
        }

        if (silenceSegments.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            status: 'no_silence',
            message: 'No silence detected with current settings.',
            silenceSegments: []
          }));
        }

        // Step 3: Calculate keep segments with padding
        const keepSegments = [];
        let lastEnd = 0;

        for (const seg of silenceSegments) {
          let keepStart = lastEnd;
          let keepEnd = Math.max(keepStart, seg.start + targetPadding);
          if (keepEnd > keepStart + 0.05) { // Minimum 50ms clip
            keepSegments.push({ start: keepStart, end: keepEnd });
          }
          lastEnd = Math.max(seg.end - targetPadding, keepEnd);
        }

        if (lastEnd < totalDuration - 0.05) {
          keepSegments.push({ start: lastEnd, end: totalDuration });
        }

        // Determine clean extension for standard browser preview playback
        const isVideo = fullLog.includes('Video:');
        const finalExt = isVideo ? '.mp4' : (['.wav', '.aac', '.flac', '.ogg'].includes(ext.toLowerCase()) ? ext.toLowerCase() : '.mp3');
        const outId = `clean_${Date.now()}${finalExt}`;
        const outputPath = path.join(OUTPUT_DIR, outId);

        // Build filter_complex
        let filterComplex = '';
        let concatInputs = '';

        for (let i = 0; i < keepSegments.length; i++) {
          const s = keepSegments[i];
          if (isVideo) {
            filterComplex += `[0:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}];`;
            filterComplex += `[0:a]atrim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}];`;
            concatInputs += `[v${i}][a${i}]`;
          } else {
            filterComplex += `[0:a]atrim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}];`;
            concatInputs += `[a${i}]`;
          }
        }

        filterComplex += `${concatInputs}concat=n=${keepSegments.length}:v=${isVideo ? 1 : 0}:a=1${isVideo ? '[outv][outa]' : '[out]'}`;

        // Write filter complex to temporary script file to bypass command line length limits
        const scriptId = `filter_${Date.now()}.txt`;
        const scriptPath = path.join(UPLOAD_DIR, scriptId);
        fs.writeFileSync(scriptPath, filterComplex, 'utf8');

        const processArgs = [
          '-y',
          '-i', inputPath,
          '-filter_complex_script', scriptPath
        ];

        if (isVideo) {
          processArgs.push('-map', '[outv]', '-map', '[outa]');
          processArgs.push(
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-preset', 'veryfast',
            '-crf', '22',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-threads', '0',
            '-movflags', '+faststart'
          );
        } else {
          processArgs.push('-map', '[out]');
          processArgs.push('-c:a', 'libmp3lame', '-b:a', '192k');
        }

        processArgs.push(outputPath);

        const cutRes = await runFFmpeg(processArgs);

        // Clean up filter script file
        try { fs.unlinkSync(scriptPath); } catch (e) {}

        if (cutRes.code !== 0) {
          throw new Error(`FFmpeg failed with code ${cutRes.code}: ${cutRes.stderr.slice(-400)}`);
        }

        const newStats = fs.statSync(outputPath);
        const newDuration = keepSegments.reduce((acc, s) => acc + (s.end - s.start), 0);
        const savedDuration = Math.max(0, totalDuration - newDuration);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'success',
          downloadUrl: `/outputs/${outId}`,
          filename: `cleaned_${originalName}`,
          originalDuration: totalDuration,
          newDuration: newDuration,
          savedDuration: savedDuration,
          silenceCount: silenceSegments.length,
          outputSize: newStats.size,
          isVideo: isVideo
        }));

      } catch (procErr) {
        console.error('Processing error:', procErr);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: procErr.message }));
      }
    });

    return;
  }

  // 2. Serve static outputs with HTTP 206 Partial Content (essential for video players & seeking)
  if (req.url.startsWith('/outputs/')) {
    const filename = path.basename(req.url);
    const filePath = path.join(OUTPUT_DIR, filename);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.stat(filePath, (statErr, stats) => {
      if (statErr || !stats.isFile()) {
        res.writeHead(404);
        return res.end('Output not found');
      }

      const fileSize = stats.size;
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });
        const head = {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*'
        };
        res.writeHead(206, head);
        file.pipe(res);
      } else {
        const head = {
          'Content-Length': fileSize,
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*'
        };
        res.writeHead(200, head);
        fs.createReadStream(filePath).pipe(res);
      }
    });
    return;
  }

  // 3. Static frontend files
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.timeout = 600000; // 10 minutes
server.keepAliveTimeout = 600000;
server.headersTimeout = 605000;

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Native FFmpeg engine: ENABLED (${FFMPEG_PATH})`);
});
