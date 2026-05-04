const express = require("express"); // requires the package
const app = express();
const PORT = 8383;

let data = ["james"];

// Middleware
app.use(express.json());
// part of configuring your server
// just before you hit that endpoint

// ENDPOINT - HTTP verbs (method) && Routes (or paths)

// Type 1 - website endpoints, for sending back html, typically when user enters a url in a browser

// req.method for the method

app.get("/", (req, res) => {
  console.log("User requested the home page website");
  res.send(`
        <body style="background:pink;color: blue;">
        <h1>DATA:</h1>
            <p>${JSON.stringify(data)}</p>
            <a href="/dashboard">Dashboard</a>
        </body>
        <script>console.log('This is my script')</script>
        `);
});

app.get("/dashboard", (req, res) => {
  res.send(`
        <body>
        <h1>dashboard</h1>
        <a href="/">home</a>
        </body>
        
        
        `);
});

// Type 2 - API endpoints
// crud := create-post read-get update-put delete-delete
// client emulator helps out

app.get("/api/data", (req, res) => {
  console.log("This one was for data");
  res.status(599).send(data);
});

app.post("/api/data", (req, res) => {
  // someone wants to create a user (for example when they click a sign up button)
  // the user clicks the sign up button after entering their credentials, and their browser is wired up to send out a network request to the server to handle that action
  const newEntry = req.body;
  console.log(newEntry);
  data.push(newEntry.name);
  res.sendStatus(201); // created outcome
});

app.delete("/api/data", (req, res) => {
  data.pop();
  console.log("We deleted the element off the end of the array");
  res.sendStatus(203);
});

// pass in arrow function as call back function
// app.listen() runs on call stack
// callback function is executed via the event loop, macrotask, event queue
app.listen(PORT, () => console.log(`Server has started on: ${PORT}`));

// instead of require
// import fs from "fs"
// "type":"module"

// URL -> http://localhost:8383
// IP -> 127.0.0.1:8383
// say you didn't define any get
// enter the url and check network tab and the headers, cannot get
