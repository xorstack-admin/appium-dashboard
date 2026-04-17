const multer = require('multer');

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB per file (zip files can be larger)
  fileFilter(req, file, cb) {
    const allowed = ['.html', '.xml', '.json', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.zip'];
    const ext = '.' + file.originalname.split('.').pop().toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error(`File type ${ext} not allowed`));
  },
});

module.exports = upload;
