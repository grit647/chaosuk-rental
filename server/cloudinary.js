// Persistent image storage for things that must survive a deploy — payment
// slip photos specifically. Render's free tier disk is ephemeral (wiped on
// every deploy/restart), which was a real problem: a slip could sit
// "pending review" for hours/days, and any code deploy in between would
// silently delete the image file even though the extracted data (amount,
// date, sender) stayed intact on the Sheet. Cloudinary's free tier gives
// genuinely persistent, CDN-backed storage instead.
const cloudinary = require('cloudinary').v2;

function isConfigured() {
  return !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

if (isConfigured()) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

// Uploads a Buffer (e.g. a slip photo fetched from LINE) and returns a
// permanent HTTPS URL. folder groups uploads for tidiness in the Cloudinary
// dashboard (e.g. "chaosuk-rental/slips").
function uploadBuffer(buffer, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (err, result) => {
        if (err) return reject(err);
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

module.exports = { isConfigured, uploadBuffer };
