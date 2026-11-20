const bcrypt = require("bcryptjs");

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("Run this command in a terminal so the password can be entered without echo.");
  process.exit(1);
}

async function main() {
  const input = process.stdin;
  const output = process.stdout;
  const passwordCharacters = [];
  output.write("Admin password (input hidden): ");
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();

  const password = await new Promise((resolve, reject) => {
    input.on("data", (character) => {
      if (character === "\u0003") {
        reject(new Error("Password entry cancelled."));
        return;
      }
      if (character === "\r" || character === "\n") {
        output.write("\n");
        resolve(passwordCharacters.join(""));
        return;
      }
      if (character === "\u007f" || character === "\b") {
        passwordCharacters.pop();
        return;
      }
      passwordCharacters.push(character);
    });
  }).finally(() => {
    input.setRawMode(false);
    input.pause();
  });

  if (Array.from(password).length < 12 || Buffer.byteLength(password, "utf8") > 72) {
    throw new Error("Use at least 12 characters and no more than 72 UTF-8 bytes.");
  }

  console.log(await bcrypt.hash(password, 12));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
