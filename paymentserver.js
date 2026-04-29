// Trigger redeploy: 2026-03-28
require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const QRCode = require('qrcode');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const twilio = require('twilio');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const bodyParser = require('body-parser');
const sgMail = require('@sendgrid/mail');
const path = require('path');
const app = express();
const stripeKey = process.env.STRIPE_SECRET_KEY;
let stripe = null;
if (stripeKey) {
  stripe = Stripe(stripeKey);
}
const razorpayKeyId = process.env.RAZORPAY_KEY_ID;
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET;
let razorpay = null;
if (razorpayKeyId && razorpayKeySecret) {
  razorpay = new Razorpay({
    key_id: razorpayKeyId,
    key_secret: razorpayKeySecret
  });
}
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

app.use(cors());
app.use(express.json());
app.use(bodyParser.json());
// Serve static files (CSS, images, etc.)
app.use(express.static(path.join(__dirname, '../ui')));
// Serve HTML files directly from /ui/html for any direct GET request
app.use(express.static(path.join(__dirname, '../ui/html')));

// Serve LoginPage.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../ui/html/LoginPage.html'));
});

// Email setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Twilio setup
const twilioSid = process.env.TWILIO_ACCOUNT_SID;
const twilioToken = process.env.TWILIO_AUTH_TOKEN;
let client = null;
if (twilioSid && twilioToken && twilioSid.startsWith('AC')) {
  client = twilio(twilioSid, twilioToken);
}

// MongoDB connection
const mongoUri = process.env.MONGO_URL || 'mongodb://localhost:27017/globaldigipulse';

function connectWithRetry() {
  mongoose.connect(mongoUri)
    .then(() => console.log('MongoDB connected (mongoose)'))
    .catch(err => {
      console.error('MongoDB connection error:', err);
      setTimeout(connectWithRetry, 5000); // Retry after 5 seconds
    });
}
connectWithRetry();

// Use either external model or inline schema, not both
let User;
try {
  User = require('./models/User'); // If external model exists
} catch (e) {
  const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    resetToken: { type: String },
    resetTokenExpiry: { type: Date },
    // New flags to persist payment status
    scanPaid: { type: Boolean, default: false },
    campaignPaid: { type: Boolean, default: false }
  });
  User = mongoose.models.User || mongoose.model('User', userSchema);
}

// Stripe Checkout Session
if (stripe) {
app.post('/create-checkout-session', async (req, res) => {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: { name: 'Your Product' },
        unit_amount: 1000, // $10.00
      },
      quantity: 1,
    }],
    mode: 'payment',
    success_url: 'http://localhost:3000/success',
    cancel_url: 'http://localhost:3000/cancel',
  });
  res.json({ id: session.id });
});

// QR Code Payment Link
app.get('/payment-qr', async (req, res) => {
  const paymentUrl = 'https://buy.stripe.com/YOUR_REAL_PAYMENT_LINK'; // <-- Replace with your real Stripe payment link
  const qr = await QRCode.toDataURL(paymentUrl);
  res.send(`<img src="${qr}" alt="Scan to Pay">`);
});
}

// Razorpay Order Creation
if (razorpay) {
app.post('/create-razorpay-order', async (req, res) => {
  const options = {
    amount: 1000, // Amount in paise (₹10.00)
    currency: "INR",
    receipt: "order_rcptid_11",
    notes: { brand: "GLOBAL DIGI PULSE" },
    name: "GLOBAL DIGI PULSE",
    description: "Access Program"
  };
  try {
    const order = await razorpay.orders.create(options);
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
}

// Create Razorpay Payment Link for ₹999
app.post('/create-payment-link', async (req, res) => {
  try {
    const { userId, email } = req.body;
    const paymentLink = await razorpay.paymentLink.create({
      amount: 99900, // ₹999 in paise
      currency: 'INR',
      accept_partial: false,
      description: 'GLOBAL DIGI PULSE Access Program',
      customer: {
        name: userId || 'User',
        email: email || '',
      },
      notify: { sms: false, email: true },
      callback_url: 'http://localhost:3000/payment-success',
      callback_method: 'get',
    });
    res.json({ url: paymentLink.short_url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create payment link', details: err.message });
  }
});

// Razorpay Webhook for payment confirmation
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET; // Set this in Razorpay dashboard and .env
  const signature = req.headers['x-razorpay-signature'];
  const body = req.body;

  // Verify webhook signature
  const expectedSignature = crypto.createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  if (signature === expectedSignature) {
    const event = JSON.parse(body);
    if (event.event === 'payment.captured') {
      // Payment successful, update your DB or trigger notification
      console.log('Payment confirmed:', event.payload.payment.entity);
      // Example: send email, update user status, etc.
    }
    res.status(200).send('Webhook received');
  } else {
    res.status(400).send('Invalid signature');
  }
});

// Razorpay webhook endpoint
app.post('/razorpay-webhook', express.json({ type: 'application/json' }), async (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers['x-razorpay-signature'];
  const body = JSON.stringify(req.body);

  const expectedSignature = crypto.createHmac('sha256', webhookSecret)
    .update(body)
    .digest('hex');

  if (signature === expectedSignature) {
    const event = req.body.event;
    if (event === 'payment.captured') {
      const payment = req.body.payload.payment.entity;
      // Example: userId or purpose stored in payment.notes
      const userId = payment.notes && payment.notes.userId;
      const purpose = payment.notes && payment.notes.purpose;
      try {
        if (userId) {
          if (purpose === 'campaign') {
            await User.findByIdAndUpdate(userId, { campaignPaid: true });
            console.log('Marked campaignPaid for user', userId);
          } else if (purpose === 'scan') {
            await User.findByIdAndUpdate(userId, { scanPaid: true });
            console.log('Marked scanPaid for user', userId);
          } else {
            // Generic access flag for older payments
            await User.findByIdAndUpdate(userId, { accessGranted: true });
            console.log('Marked accessGranted for user', userId);
          }
        }
        // You can also send confirmation email here
      } catch (err) {
        console.error('Error updating user payment status:', err);
      }
    }
    res.status(200).send('Webhook received');
  } else {
    res.status(400).send('Invalid signature');
  }
});

// Owner notification endpoint
if (client) {
app.post('/payment-notify-owner', async (req, res) => {
  const { paymentId } = req.body;

  // Email notification
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: 'OWNER_EMAIL@gmail.com',
    subject: 'New Payment Received',
    text: `A new payment was received. Payment ID: ${paymentId}`
  };

  // SMS notification
  const smsOptions = {
    body: `New payment received! Payment ID: ${paymentId}`,
    from: 'YOUR_TWILIO_PHONE_NUMBER',
    to: 'OWNER_MOBILE_NUMBER'
  };

  try {
    await transporter.sendMail(mailOptions);
    await client.messages.create(smsOptions);
    res.status(200).json({ message: 'Owner notified via email and SMS.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send notifications.' });
  }
});
}

app.post('/send-login-thankyou', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: email,
    subject: 'Thank You for Logging In',
    text: 'Thank you for logging in to GLOBAL DIGI PULSE! We appreciate your interest.'
  };

  try {
    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: 'Thank you email sent.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send email.' });
  }
});

app.post('/send-register-thankyou', async (req, res) => {
  const { email, username, password } = req.body;
  if (!email || !username || !password) return res.status(400).json({ error: 'Email, username, and password required.' });

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: email,
    subject: 'Thank You for Registering',
    text: `Thank you for registering in GLOBAL DIGI PULSE!\n\nYour credentials:\nUsername: ${username}\nPassword: ${password}\n\nKeep your credentials safe.`
  };

  try {
    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: 'Registration email sent.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send email.' });
  }
});

// Registration endpoint
app.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) return res.status(400).json({ success: false, message: 'Username, email, and password required.' });

  try {
    // Check if user exists by username or email
    const existing = await User.findOne({ $or: [{ username }, { email }] });
    if (existing) {
      return res.json({ success: false, message: 'User or email already exists.' });
    }
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    // Store user
    await User.create({ username, email, password: hashedPassword });
    // Send credentials email
    await fetch('http://localhost:3000/send-register-thankyou', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, username, password })
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Registration failed.' });
  }
});

// Login endpoint
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required.' });

  try {
    // Find user by username or email
    const user = await User.findOne({ $or: [ { username }, { email: username } ] });
    if (!user) {
      return res.json({ success: false, message: 'User not found.' });
    }
    // Compare password
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.json({ success: false, message: 'Incorrect password.' });
    }
    // Send thank you email after successful login
    if (username.includes('@')) {
      await fetch('http://localhost:3000/send-login-thankyou', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: username })
      });
    }
    res.json({ success: true, accessGranted: !!user.accessGranted });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Login failed.' });
  }
});

// Forgot user endpoint
app.post('/forgot-user', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    console.error('Forgot-user: Email required');
    return res.status(400).json({ success: false, error: 'Email required.' });
  }

  try {
    // Find user by email
    const user = await User.findOne({ email });
    if (!user) {
      console.error('Forgot-user: User not found for email', email);
      return res.json({ success: false, error: 'User not found.' });
    }
    // Generate secure reset token
    const crypto = require('crypto');
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + 1000 * 60 * 60); // 1 hour expiry
    user.resetToken = resetToken;
    user.resetTokenExpiry = resetTokenExpiry;
    await user.save();
    // Provide reset link in response (no email)
    // Use absolute URL for reset link
    const baseUrl = req.protocol + '://' + req.get('host');
    const resetLink = `${baseUrl}/reset-password.html?token=${resetToken}`;
    res.json({ success: true, resetLink });
  } catch (error) {
    console.error('Forgot-user: Server error', error);
    res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// Reset username and password endpoint
app.post('/reset-username-password', async (req, res) => {
  const { token, newUsername, newPassword } = req.body;
  if (!token || !newUsername || !newPassword) {
    return res.status(400).json({ success: false, error: 'Token, new username, and new password required.' });
  }
  try {
    const user = await User.findOne({ resetToken: token, resetTokenExpiry: { $gt: new Date() } });
    if (!user) {
      return res.status(400).json({ success: false, error: 'Invalid or expired token.' });
    }
    // Check if new username is taken
    const existing = await User.findOne({ username: newUsername });
    if (existing && existing._id.toString() !== user._id.toString()) {
      return res.status(400).json({ success: false, error: 'Username already taken.' });
    }
    user.username = newUsername;
    user.password = await bcrypt.hash(newPassword, 10);
    user.resetToken = undefined;
    user.resetTokenExpiry = undefined;
    await user.save();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// Create Razorpay order for custom amount, include userId and purpose in notes
app.post('/create-order', async (req, res) => {
  try {
    const { userId, amount, purpose } = req.body;
    if (!razorpay) {
      console.error('Razorpay not initialized. KeyId:', process.env.RAZORPAY_KEY_ID, 'KeySecret:', process.env.RAZORPAY_KEY_SECRET);
      return res.status(500).json({ error: 'Razorpay not initialized' });
    }
    // Determine purpose: prefer explicit 'purpose', else infer from amount
    let orderPurpose = 'access';
    if (purpose) orderPurpose = purpose;
    else if (amount === 149900) orderPurpose = 'campaign';
    else if (amount === 99900) orderPurpose = 'scan';

    try {
      const order = await razorpay.orders.create({
        amount: typeof amount === 'number' && amount > 0 ? amount : 99900, // Use provided amount (in paise) or default to ₹999
        currency: 'INR',
        payment_capture: 1,
        notes: { purpose: orderPurpose, userId: userId || '' }
      });
      console.log('Razorpay order created:', order);
      res.json(order);
    } catch (err) {
      console.error('Razorpay order error:', err, 'KeyId:', process.env.RAZORPAY_KEY_ID, 'KeySecret:', process.env.RAZORPAY_KEY_SECRET);
      res.status(500).json({ error: 'Failed to create order', details: err.message });
    }
  } catch (error) {
    console.error('General /create-order error:', error);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.get('/check-payment-status', async (req, res) => {
  const paymentId = req.query.payment_id;
  if (!paymentId) return res.json({ verified: false });
  try {
    const payment = await razorpay.payments.fetch(paymentId);
    if (payment.amount === 100000 && payment.status === 'captured') {
      paymentStatus[paymentId] = true;
      res.json({ verified: true });
    } else {
      res.json({ verified: false });
    }
  } catch {
    res.json({ verified: false });
  }
});

// Reset password endpoint
app.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    return res.status(400).json({ success: false, error: 'Token and new password required.' });
  }
  try {
    const user = await User.findOne({ resetToken: token, resetTokenExpiry: { $gt: new Date() } });
    if (!user) {
      return res.status(400).json({ success: false, error: 'Invalid or expired token.' });
    }
    user.password = newPassword;
    user.resetToken = undefined;
    user.resetTokenExpiry = undefined;
    await user.save();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// Serve ResetPassword.html for both /reset-password.html and /ResetPassword.html (case-insensitive)
app.get(/^\/reset-password\.html$/i, (req, res) => {
  res.sendFile(path.join(__dirname, '../ui/html/ResetPassword.html'));
});

// Razorpay Payment Verification Endpoint
app.post('/verify-payment', async (req, res) => {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature, userId } = req.body;
  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
    return res.status(400).json({ success: false, error: 'Missing payment verification data.' });
  }
  try {
    // Generate expected signature
    const generated_signature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');
    if (generated_signature === razorpay_signature) {
      // Optionally, mark user as paid in DB
      if (userId) {
        await User.findByIdAndUpdate(userId, { accessGranted: true });
      }
      return res.json({ success: true });
    } else {
      return res.status(400).json({ success: false, error: 'Invalid signature.' });
    }
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// Utility endpoint: Fix accessGranted for users who have paid but missing flag
app.post('/fix-access-granted', async (req, res) => {
  try {
    // Find all payments with userId in notes and status 'captured'
    const payments = await razorpay.payments.all({ from: 0 }); // fetch all payments
    let updated = 0;
    for (const payment of payments.items) {
      if (payment.status === 'captured' && payment.notes && payment.notes.userId) {
        const user = await User.findById(payment.notes.userId);
        if (user && !user.accessGranted) {
          await User.findByIdAndUpdate(payment.notes.userId, { accessGranted: true });
          updated++;
        }
      }
    }
    res.json({ success: true, updated });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint to query user payment status
app.get('/user-access-status', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const user = await User.findById(userId).select('scanPaid campaignPaid accessGranted');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ scanPaid: !!user.scanPaid, campaignPaid: !!user.campaignPaid, accessGranted: !!user.accessGranted });
  } catch (err) {
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

app.listen(5050, () => {
  console.log('Payment server running on http://localhost:5050');
});
