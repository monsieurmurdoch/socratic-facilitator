/**
 * Storage Service
 *
 * Handles file uploads and storage using local filesystem
 * Compatible with Railway volumes
 */

const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');

const STORAGE_PATH = process.env.STORAGE_PATH || './uploads';

// Ensure storage directory exists
async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {
    // Directory exists
  }
}

// Sanitize filename
function sanitizeFilename(filename) {
  return filename
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .toLowerCase();
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    await ensureDir(STORAGE_PATH);
    cb(null, STORAGE_PATH);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const safeName = sanitizeFilename(file.originalname);
    const uniqueName = `${timestamp}-${safeName}`;
    file.sanitizedFilename = safeName;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024 // 25MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'text/plain',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    const allowedExtensions = ['.pdf', '.txt', '.docx'];

    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${file.mimetype || ext}`));
    }
  }
});

class StorageService {
  constructor() {
    this.upload = upload;
  }

  async save(id, buffer, filename) {
    await ensureDir(path.join(STORAGE_PATH, id));
    const safeName = sanitizeFilename(filename);
    const filepath = path.join(STORAGE_PATH, id, safeName);
    await fs.writeFile(filepath, buffer);
    return filepath;
  }

  async read(filepath) {
    const fullPath = path.isAbsolute(filepath) ? filepath : path.join(STORAGE_PATH, filepath);
    return fs.readFile(fullPath);
  }

  async delete(filepath) {
    try {
      const fullPath = path.isAbsolute(filepath) ? filepath : path.join(STORAGE_PATH, filepath);
      await fs.unlink(fullPath);
    } catch (e) {
      // File doesn't exist
    }
  }

  async exists(filepath) {
    try {
      const fullPath = path.isAbsolute(filepath) ? filepath : path.join(STORAGE_PATH, filepath);
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = new StorageService();
