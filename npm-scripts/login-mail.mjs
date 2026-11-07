import { appApi } from "./app-api.mjs";
import { DEV, parseStage, STAGES } from "./stages.mjs";

const stage = parseStage(process.argv[2] ?? DEV);
if (!STAGES[stage].captureLoginMail) {
  console.error(`${stage} sends login mail and captures none; pick a stage that captures`);
  process.exit(2);
}

const response = await appApi(stage)("GET", "/api/dev/login-mail");
if (!response.ok) {
  console.error(`${response.status}`, response.body);
  process.exit(1);
}

const LINK = /https?:\/\/\S+/g;

for (const mail of response.body.messages) {
  console.log(`${new Date(mail.capturedAt).toISOString()}  ${mail.recipient}  ${mail.subject}`);
  const links = mail.body.match(LINK) ?? [];
  for (const line of links.length > 0 ? links : [mail.body.split("\n")[0]]) {
    console.log(`  ${line}`);
  }
}
if (response.body.messages.length === 0) console.log("no login mail captured in the last hour");
