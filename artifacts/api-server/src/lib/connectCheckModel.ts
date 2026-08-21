export interface ConnectCheck {
  id: string;
  label: string;
  status: "ok" | "warning" | "error" | "unknown";
  detail: string;
}

export function unknownConnectChecks(): ConnectCheck[] {
  return [
    {
      id: "connect:production",
      label: "Connect productie",
      status: "unknown",
      detail: "Nog geen betrouwbare productiemeting beschikbaar.",
    },
    {
      id: "connect:build",
      label: "Connect bouwcontrole",
      status: "unknown",
      detail: "Nog geen betrouwbare bouwmeting beschikbaar.",
    },
    {
      id: "connect:db-backup",
      label: "Connect databaseback-up",
      status: "unknown",
      detail: "Nog geen betrouwbare back-upmeting beschikbaar.",
    },
    {
      id: "connect:nas-pull",
      label: "Connect NAS-synchronisatie",
      status: "unknown",
      detail: "Nog geen betrouwbare NAS-meting beschikbaar.",
    },
    {
      id: "connect:mail",
      label: "Connect uitgaande mail",
      status: "unknown",
      detail: "Nog geen betrouwbare mailmeting beschikbaar.",
    },
  ];
}