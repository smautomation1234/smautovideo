import { GoogleAuth } from "google-auth-library";

let auth: GoogleAuth | undefined;

function credentials() {
  const encoded = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  if (!encoded) return undefined;
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 is not valid base64-encoded JSON.");
  }
}

export async function googleAccessToken() {
  auth ??= new GoogleAuth({
    credentials: credentials(),
    scopes: ["https://www.googleapis.com/auth/cloud-platform"]
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token.token) throw new Error("Google ADC did not return an access token.");
  return token.token;
}
