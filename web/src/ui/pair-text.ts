// "Pair a phone" says which CAST the device joins. The pairing code is always the hub's (the server this browser is
// paired with): opened from a city (/city/<id>/) the phone still joins the hub, and its link opens that city through
// it. Pure (no DOM), for tests.

/** One line for the Pair a phone section; null when there is only one CAST and nothing to tell apart. */
export function pairTargetLine(hubName: string | null, cityName: string | null, manyCities: boolean): string | null {
  const hub = hubName?.trim() || 'this hub';
  if (cityName) return `This pairs a device with ${hub}, the CAST this browser signed in to, and opens ${cityName} on it.`;
  if (manyCities && hubName) return `This pairs a device with ${hub}. Your other cities open from its city menu.`;
  return null;
}
