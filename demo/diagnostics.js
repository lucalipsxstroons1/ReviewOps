import { exec } from "node:child_process";
import express from "express";

const router = express.Router();

// Demo for #17: this endpoint passes user input to a shell. ReviewOps should
// comment on the exec call below. The pull request is closed, never merged.
router.get("/ping", (req, res) => {
  const host = req.query.host;
  exec(`ping -c 1 ${host}`, (error, stdout) => {
    if (error) return res.status(500).send("ping failed");
    res.send(stdout);
  });
});

export default router;
