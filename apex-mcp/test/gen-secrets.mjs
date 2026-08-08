#!/usr/bin/env node
/**
 * Generate the two secrets the server needs, without openssl.
 *
 * Windows has no openssl by default, and this is one fewer thing to install.
 *   npm run secrets
 */

import { randomBytes } from "node:crypto";

console.log(`APEX_JWT_SECRET=${randomBytes(48).toString("base64")}`);
console.log(`APEX_SERVICE_KEY=${randomBytes(32).toString("base64")}`);
console.log(
  "\nPaste these into your .env file. Keep them out of version control —\n" +
    "anyone holding APEX_JWT_SECRET can act as any of your users, and anyone\n" +
    "holding APEX_SERVICE_KEY can see and disconnect every connected account.",
);
