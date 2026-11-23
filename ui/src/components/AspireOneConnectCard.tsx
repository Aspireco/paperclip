import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { authApi } from "../api/auth";
import { healthApi } from "../api/health";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { Card } from "./ui/card";

/**
 * Connect this Paperclip account to Aspire One (auth.aspireco.ca), so the Aspire One apps page and
 * "Sign in with Aspire One" open Paperclip with no password here. Connecting from inside a signed-in
 * session is the only way the two accounts are tied (never by matching email addresses).
 */
export function AspireOneConnectCard() {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const health = useQuery({ queryKey: queryKeys.health, queryFn: () => healthApi.get(), retry: false });
  const accounts = useQuery({ queryKey: ["auth", "accounts"], queryFn: () => authApi.listAccounts() });
  const connected = (accounts.data ?? []).some((account) => account.providerId === "aspire-one");

  const connect = useMutation({
    mutationFn: () => authApi.linkAspireOne(window.location.pathname),
    onSuccess: (url) => {
      if (url) window.location.assign(url);
      else setMessage("Aspire One is unavailable right now.");
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : "Could not connect Aspire One."),
  });
  const disconnect = useMutation({
    mutationFn: () => authApi.unlinkAspireOne(),
    onSuccess: async () => {
      setMessage("Disconnected. Sign in with your email and password from now on.");
      await queryClient.invalidateQueries({ queryKey: ["auth", "accounts"] });
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : "Could not disconnect Aspire One."),
  });

  if (!health.data?.features?.aspireOneSignIn) return null;
  return (
    <Card className="block rounded-(--rad-28) border-border/70 p-6">
      <h2 className="text-base font-semibold">Aspire One sign-in</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {connected
          ? "Connected. You can open Paperclip from your Aspire One apps page."
          : "Connect your Aspire One login once to open Paperclip from the Aspire One apps page. Your email and password keep working."}
      </p>
      <div className="mt-4">
        {connected ? (
          <Button type="button" variant="outline" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
            Disconnect Aspire One
          </Button>
        ) : (
          <Button type="button" disabled={connect.isPending || accounts.isLoading} onClick={() => connect.mutate()}>
            {connect.isPending ? "Opening Aspire One…" : "Connect Aspire One"}
          </Button>
        )}
      </div>
      {message ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}
    </Card>
  );
}
