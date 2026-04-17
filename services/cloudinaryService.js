const cloudinary = require('../config/cloudinary');

function sanitizePublicId(id) {
  if (!id) return undefined;
  return id.replace(/[^a-zA-Z0-9_\-\.\/]/g, '_').replace(/_+/g, '_');
}

async function uploadBuffer(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder ? sanitizePublicId(options.folder) : 'vya-reports',
        resource_type: options.resourceType || 'auto',
        public_id: sanitizePublicId(options.publicId),
      },
      (err, result) => {
        if (err) reject(err);
        else resolve({ url: result.secure_url, publicId: result.public_id, size: result.bytes });
      }
    );
    stream.end(buffer);
  });
}

async function deleteFile(publicId, resourceType = 'raw') {
  return cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
}

module.exports = { uploadBuffer, deleteFile };
