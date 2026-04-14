import type {
  ScompTransportPrincipal,
  ScompTransportSecurityContext,
  ScompTransportSecurityPolicy,
} from "@scomp/types";

export interface CheckSecurityResult {
  allowed: boolean;
  principal?: ScompTransportPrincipal;
}

export async function checkSecurity(
  policy: ScompTransportSecurityPolicy | undefined,
  ctx: Omit<ScompTransportSecurityContext, "principal">,
): Promise<CheckSecurityResult> {
  if (!policy) {
    return { allowed: true };
  }

  const principal = policy.authenticate
    ? await policy.authenticate(ctx)
    : undefined;

  if (!policy.authorize) {
    return { allowed: true, principal: principal ?? undefined };
  }

  const allowed = Boolean(
    await policy.authorize({
      ...ctx,
      principal: principal ?? undefined,
    }),
  );

  return { allowed, principal: principal ?? undefined };
}
