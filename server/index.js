require('dotenv').config();
const express = require('express');
const path = require('path');

// Safety net: an uncaught promise rejection anywhere (e.g. a transient Google
// Sheets API hiccup) should never take the whole server down. Log it and keep going.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const ROOT = path.join(__dirname, '..');
const app = express();
app.use(express.json({ limit: '5mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'Rental Management.dc.html')));
app.get('/support.js', (req, res) => res.sendFile(path.join(ROOT, 'support.js')));
app.get('/doc-page.js', (req, res) => res.sendFile(path.join(ROOT, 'doc-page.js')));
app.get('/Lease Agreement - Room 302.dc.html', (req, res) => res.sendFile(path.join(ROOT, 'Lease Agreement - Room 302.dc.html')));

app.use('/api/bootstrap', require('./routes/bootstrap'));
app.use('/api/rooms', require('./routes/rooms'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/maintenance', require('./routes/maintenance'));
app.use('/api/expenses', require('./routes/expenses'));
app.use('/api/calendar', require('./routes/calendar'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/line', require('./routes/line'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`เช่าสุข server running on http://localhost:${PORT}`));
