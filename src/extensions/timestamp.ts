// Pi extension: attach the local time to each prompt as a hidden custom
// message, so the model knows when the user submitted it.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function timeLine(): string {
  const d = new Date();
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
  const date = d.toLocaleDateString("en-CA"); // YYYY-MM-DD
  const time = d.toLocaleTimeString("en-GB", { hour12: false });
  const tz = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName")?.value;
  return `Time: ${weekday} ${date} ${time}${tz ? ` ${tz}` : ""}`;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", () => ({
    message: { customType: "timestamp", content: timeLine(), display: false },
  }));
}
