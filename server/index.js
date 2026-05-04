const express = require("express");
const path = require("path");
const searchRouter = require("./routes/search");

const app = express();
const PORT = process.env.PORT || 3000;

const webDir = path.join(__dirname, "..", "web");
app.use(express.static(webDir));
app.use("/api", searchRouter);

app.listen(PORT, () => {
  console.log(`AlgoLens listening on http://localhost:${PORT}`);
});
