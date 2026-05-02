// Basic Node.js server for login using MongoDB (no frameworks)
// Save as c:/project/app/server/loginServer.js
require('dotenv').config({ path: './server/.env' });
const { MongoClient } = require("mongodb");
const express = require("express");
const cors = require("cors");
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const url = process.env.MONGO_URL || process.env.MONGO_URI;
console.log("MongoDB URL:", url); // Debug log
const client = new MongoClient(url);

app.use('/ui/html', express.static(path.join(__dirname, '../ui/html')));
app.use('/images', express.static(path.join(__dirname, '../images')));
app.use('/html', express.static(path.join(__dirname, '../ui/html'))); // for legacy paths

async function startServer() {
  try {
    await client.connect();
    console.log("Connected to MongoDB");

    // 👇 TYPE IT HERE
    const db = client.db("userdb2");
    const users = db.collection("users");

    // Example route
    app.post("/register", async (req, res) => {
      const { username, email, password, fullname } = req.body;
      console.log("Register attempt:", req.body); // Log registration data
      if (!username || !email || !password) {
        return res.json({ success: false, message: "Username, email, and password required." });
      }
      try {
        // Check for existing username or email
        const existingUser = await users.findOne({ $or: [ { username }, { email } ] });
        if (existingUser) {
          return res.json({ success: false, message: "User or email already exists." });
        }
        // Insert user, fullname is optional
        await users.insertOne({ username, email, password, fullname: fullname || null });
        res.json({ success: true, message: "User Registered" });
      } catch (err) {
        console.error("Registration error:", err);
        res.status(500).json({ success: false, message: "Server/database error. Please try again." });
      }
    });
    app.post("/login", async (req, res) => {
      const { username, password } = req.body;
      const user = await users.findOne({ username, password });
      if (user) {
        res.json({ success: true });
      } else {
        res.json({ success: false, error: "Invalid credentials" });
      }
    });

    app.listen(3000, () => {
      console.log("Server running on port 3000");
    });

  } catch (err) {
    console.log(err);
  }
}

startServer();

