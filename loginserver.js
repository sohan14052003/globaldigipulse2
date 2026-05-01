// Basic Node.js server for login using MongoDB (no frameworks)
// Save as c:/project/app/server/loginServer.js
const { MongoClient } = require("mongodb");
const express = require("express");
const cors = require("cors");
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const url = process.env.MONGO_URL;
const client = new MongoClient(url);

app.use('/ui/html', express.static(path.join(__dirname, '../ui/html')));
app.use('/images', express.static(path.join(__dirname, '../images')));
app.use('/html', express.static(path.join(__dirname, '../ui/html'))); // for legacy paths

async function startServer() {
  try {
    await client.connect();
    console.log("Connected to MongoDB");

    // 👇 TYPE IT HERE
    const db = client.db("userdb");
    const users = db.collection("users");

    // Example route
    app.post("/register", async (req, res) => {
      const { username, password } = req.body;
      if (!username || !password) {
        return res.json({ success: false, message: "Username and password required." });
      }
      const existingUser = await users.findOne({ username });
      if (existingUser) {
        return res.json({ success: false, message: "Username already exists." });
      }
      await users.insertOne({ username, password });
      res.json({ success: true, message: "User Registered" });
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

