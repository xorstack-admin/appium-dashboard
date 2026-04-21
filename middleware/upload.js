const multer = require('multer');

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB per file — zips can be large with screenshots
    fieldSize: 10 * 1024 * 1024, // 10MB for text fields
  },
  fileFilter(req, file, cb) {
    const allowed = ['.html', '.xml', '.json', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.zip'];
    const ext = '.' + file.originalname.split('.').pop().toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error(`File type ${ext} not allowed`));
  },
});

// Error handler middleware — converts Multer/file errors to JSON so the client sees
// proper messages instead of HTML error pages (which cause "Unexpected token '<'" errors)
function uploadErrorHandler(err, req, res, next) {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large. Maximum size is 500MB per file.' });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  return res.status(400).json({ error: err.message || 'Upload failed' });
}

module.exports = upload;
module.exports.uploadErrorHandler = uploadErrorHandler;
