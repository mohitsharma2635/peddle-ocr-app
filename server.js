const express = require('express');
const multer = require('multer');
const { createWorker } = require('tesseract.js');
const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const pdfParse = require('pdf-parse');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Convert PDF to images using pdfjs-dist
async function pdfToImages(pdfPath) {
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  
  // Disable worker to avoid issues
  pdfjsLib.GlobalWorkerOptions.workerSrc = null;
  
  const dataBuffer = fs.readFileSync(pdfPath);
  // Convert Buffer to Uint8Array
  const uint8Array = new Uint8Array(dataBuffer);
  const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
  const pdfDocument = await loadingTask.promise;
  
  const images = [];
  
  for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
    const page = await pdfDocument.getPage(pageNum);
    const viewport = page.getViewport({ scale: 2.0 });
    
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');
    
    await page.render({
      canvasContext: context,
      viewport: viewport
    }).promise;
    
    images.push({
      canvas,
      pageNumber: pageNum,
      width: viewport.width,
      height: viewport.height
    });
  }
  
  return images;
}

// Perform OCR on an image
async function performOCR(imagePath, pageNumber = 1) {
  const worker = await createWorker('eng');
  
  try {
    const { data } = await worker.recognize(imagePath);
    
    const results = data.words.map(word => ({
      text: word.text,
      confidence: word.confidence,
      bbox: {
        x0: word.bbox.x0,
        y0: word.bbox.y0,
        x1: word.bbox.x1,
        y1: word.bbox.y1
      },
      page: pageNumber
    }));
    
    await worker.terminate();
    return results;
  } catch (error) {
    await worker.terminate();
    throw error;
  }
}

// Perform OCR on canvas (for PDF pages)
async function performOCROnCanvas(canvas, pageNumber) {
  const worker = await createWorker('eng');
  
  try {
    const buffer = canvas.toBuffer('image/png');
    const { data } = await worker.recognize(buffer);
    
    const results = data.words.map(word => ({
      text: word.text,
      confidence: word.confidence,
      bbox: {
        x0: word.bbox.x0,
        y0: word.bbox.y0,
        x1: word.bbox.x1,
        y1: word.bbox.y1
      },
      page: pageNumber
    }));
    
    await worker.terminate();
    return results;
  } catch (error) {
    await worker.terminate();
    throw error;
  }
}

// Generate highlighted image
async function generateHighlightedImage(imagePath, ocrResults, outputPath) {
  const image = await loadImage(imagePath);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  
  // Draw original image
  ctx.drawImage(image, 0, 0);
  
  // Draw bounding boxes
  ocrResults.forEach(result => {
    const { x0, y0, x1, y1 } = result.bbox;
    
    // Draw rectangle
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 2;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    
    // Draw semi-transparent fill
    ctx.fillStyle = 'rgba(0, 255, 0, 0.1)';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  });
  
  // Save highlighted image
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, buffer);
  
  return outputPath;
}

// Generate highlighted image from canvas
async function generateHighlightedImageFromCanvas(sourceCanvas, ocrResults, outputPath) {
  const canvas = createCanvas(sourceCanvas.width, sourceCanvas.height);
  const ctx = canvas.getContext('2d');
  
  // Draw original canvas content
  ctx.drawImage(sourceCanvas, 0, 0);
  
  // Draw bounding boxes
  ocrResults.forEach(result => {
    const { x0, y0, x1, y1 } = result.bbox;
    
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 3;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    
    ctx.fillStyle = 'rgba(0, 255, 0, 0.15)';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  });
  
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, buffer);
  
  return outputPath;
}

// OCR endpoint
app.post('/api/ocr', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  const filePath = req.file.path;
  const fileExt = path.extname(req.file.originalname).toLowerCase();
  
  try {
    let allOcrResults = [];
    let highlightedImages = [];
    
    if (fileExt === '.pdf') {
      console.log('Processing PDF...');
      const pdfImages = await pdfToImages(filePath);
      
      for (const { canvas, pageNumber } of pdfImages) {
        console.log(`Processing page ${pageNumber}...`);
        const ocrResults = await performOCROnCanvas(canvas, pageNumber);
        allOcrResults = allOcrResults.concat(ocrResults);
        
        const outputPath = path.join('uploads', `highlighted-page-${pageNumber}-${Date.now()}.png`);
        await generateHighlightedImageFromCanvas(canvas, ocrResults, outputPath);
        highlightedImages.push({
          page: pageNumber,
          path: outputPath,
          filename: path.basename(outputPath)
        });
      }
    } else {
      console.log('Processing image...');
      const ocrResults = await performOCR(filePath);
      allOcrResults = ocrResults;
      
      const outputPath = path.join('uploads', `highlighted-${Date.now()}.png`);
      await generateHighlightedImage(filePath, ocrResults, outputPath);
      highlightedImages.push({
        page: 1,
        path: outputPath,
        filename: path.basename(outputPath)
      });
    }
    
    // Clean up uploaded file
    fs.unlinkSync(filePath);
    
    // Prepare response
    const response = {
      success: true,
      totalWords: allOcrResults.length,
      results: allOcrResults,
      highlightedImages: highlightedImages.map(img => ({
        page: img.page,
        url: `/uploads/${img.filename}`
      }))
    };
    
    res.json(response);
    
  } catch (error) {
    console.error('OCR Error:', error);
    
    // Clean up on error
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    res.status(500).json({ 
      error: 'OCR processing failed', 
      details: error.message 
    });
  }
});

// Serve uploaded files
app.use('/uploads', express.static('uploads'));

// Start server
app.listen(PORT, () => {
  console.log(`OCR Server running on http://localhost:${PORT}`);
  console.log('Upload a file to get started!');
});