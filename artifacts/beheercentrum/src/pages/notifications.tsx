import { useQuery } from "@tanstack/react-query";
import {
  getGetNotificationSettingsQueryKey,
  getNotificationSettings,
} from "@workspace/api-client-react";
import {
  Bell,
  BellOff,
  CheckCircle2,
  ExternalLink,
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PushSettingsCard } from "@/components/push-settings-card";
import { LeesSleutelsCard } from "@/components/lees-sleutels-card";

export default function NotificationsPage() {
  const { data: settings, isLoading } = useQuery({
    queryKey: getGetNotificationSettingsQueryKey(),
    queryFn: () => getNotificationSettings(),
  });

  return (
    <div className="flex flex-col gap-6 w-full pb-12 animate-in fade-in slide-in-from-bottom-4 duration-700 ease-out">
      <div className="space-y-1">
        <h1 className="text-xl md:text-2xl font-semibold tracking-tight">Meldingen</h1>
        <p className="text-sm text-muted-foreground">
          Ontvang een Slack-bericht of pushmelding op je telefoon zodra een codebase rood wordt of een grote afwijking wordt gedetecteerd.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Instellingen ophalen…
        </div>
      ) : (
        <div className="flex flex-col gap-4">

          {/* Active / inactive status */}
          <div className="rounded-xl border border-border bg-card p-5 flex items-center gap-4">
            <div className={cn(
              "p-2 rounded-lg",
              settings?.enabled
                ? "bg-emerald-500/10 text-emerald-500"
                : "bg-muted text-muted-foreground",
            )}>
              {settings?.enabled ? <Bell className="h-5 w-5" /> : <BellOff className="h-5 w-5" />}
            </div>
            <div>
              <p className="font-medium text-sm">
                {settings?.enabled ? "Meldingen zijn actief" : "Meldingen zijn uitgeschakeld"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {settings?.enabled
                  ? "De achtergrondmonitor verstuurt meldingen bij statuswijzigingen."
                  : "Stel NOTIFICATIONS_ENABLED=true in via Replit Secrets om te activeren."}
              </p>
            </div>
          </div>

          {/* Webhook status */}
          <div className="rounded-xl border border-border bg-card p-5 flex flex-col gap-3">
            <div className="flex items-start gap-3">
              <div className={cn(
                "mt-0.5 p-2 rounded-lg",
                settings?.slackWebhookConfigured
                  ? "bg-emerald-500/10 text-emerald-500"
                  : "bg-amber-500/10 text-amber-500",
              )}>
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <p className="font-medium text-sm">Slack webhook</p>
                <div className="mt-1 flex items-center gap-1.5 text-sm">
                  {settings?.slackWebhookConfigured ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                      <span className="text-emerald-500">Webhook geconfigureerd via <code className="text-xs bg-emerald-500/10 px-1 rounded">SLACK_WEBHOOK_URL</code></span>
                    </>
                  ) : (
                    <>
                      <XCircle className="h-4 w-4 text-amber-500 shrink-0" />
                      <span className="text-amber-500">Geen webhook ingesteld — meldingen worden niet verstuurd</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {!settings?.slackWebhookConfigured && (
              <div className="rounded-lg bg-muted/50 border border-border/50 p-4 text-sm space-y-2">
                <p className="font-medium">Zo stel je de webhook in:</p>
                <ol className="list-decimal list-inside space-y-1.5 text-muted-foreground text-xs leading-relaxed">
                  <li>
                    Maak een Slack-app aan via{" "}
                    <a
                      href="https://api.slack.com/apps"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground"
                    >
                      api.slack.com/apps
                      <ExternalLink className="h-3 w-3" />
                    </a>{" "}
                    en activeer <strong>Incoming Webhooks</strong>.
                  </li>
                  <li>Kopieer de webhook-URL (begint met <code className="bg-muted px-1 rounded">https://hooks.slack.com/…</code>).</li>
                  <li>
                    Voeg de URL toe als Replit Secret met de naam{" "}
                    <code className="bg-muted px-1 rounded">SLACK_WEBHOOK_URL</code>.
                  </li>
                  <li>Herstart de API-server zodat de nieuwe waarde wordt ingelezen.</li>
                </ol>
                <p className="text-xs text-muted-foreground pt-1 border-t border-border/40">
                  De URL wordt opgeslagen in Replit Secrets en nooit via de API blootgesteld.
                  Meldingen zijn uitsluitend leesbaar richting GitHub — er worden geen
                  wijzigingen doorgevoerd.
                </p>
              </div>
            )}
          </div>

          {/* Push notifications on this device */}
          <PushSettingsCard />

          {/* Leessleutels voor externe systemen */}
          <LeesSleutelsCard />

          {/* Trigger info */}
          <div className="rounded-xl border border-border/50 bg-muted/30 p-5 flex flex-col gap-2">
            <p className="text-sm font-medium text-muted-foreground">Wanneer ontvang je een melding?</p>
            <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
              <li>Een codebase gaat van groen naar rood (gefaalde GitHub Actions controle)</li>
              <li>Een nieuwe commit bevat een ongewoon grote bestandswijziging (&gt;300 regels)</li>
            </ul>
            <p className="text-xs text-muted-foreground mt-1">
              De achtergrondmonitor controleert elke 5 minuten. Een databaseslot zorgt ervoor
              dat bij meerdere serverinstanties slechts één instantie tegelijk controleert.
              Als een Slack-bericht niet aankomt, probeert de volgende pollronde het opnieuw.
            </p>
          </div>

        </div>
      )}
    </div>
  );
}
