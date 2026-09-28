import { host } from "@mini/sdk";

const root = document.getElementById("root")!;

function line(text: string): HTMLDivElement {
  const div = document.createElement("div");
  div.textContent = text;
  return div;
}

async function main(): Promise<void> {
  root.appendChild(line("hello"));

  const pong = line("waiting pong…");
  root.appendChild(pong);

  host.app.onMessage((msg: any) => {
    if (msg?.type === "pong") pong.textContent = `pong @ ${new Date(msg.at).toLocaleTimeString()}`;
  });

  const btn = document.createElement("button");
  btn.textContent = "ping app";
  btn.onclick = () => host.app.send({ type: "ping" });
  root.appendChild(btn);
}

void main();
