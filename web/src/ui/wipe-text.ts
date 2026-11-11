// The words of "Delete all CAST data?" that depend on where the page is. Through a hub (/city/<id>/) the wipe runs on
// that city's machine: the device it knows is the hub (this browser stays paired with the hub), and coming back means
// re-pairing the city from the hub's city menu, not pairing this browser again. Pure (no DOM), for tests.

/** One run of text; `em` is bold, `code` is a command. */
export type TextPart = string | { em: string } | { code: string };

export function wipeDevicesLine(cityName: string, viaHub: boolean): TextPart[] {
  return viaHub
    ? [`every device paired with ${cityName} — `, { em: 'including this hub’s pairing' }, ' — and its pairing token']
    : ['every paired device — ', { em: 'including this one' }, ' — and the pairing token'];
}

export function wipeComeBackLine(cityName: string, viaHub: boolean): TextPart[] {
  return viaHub
    ? [`CAST on ${cityName} then restarts with an empty town (your project folders stay on disk). To come back, get its new pairing link on that machine (`, { code: 'bun run pair' }, '), then choose ', { em: 'Manage cities → Re-pair' }, ' in the city menu.']
    : ['CAST then restarts with an empty town (your project folders stay on disk). To come back, pair again with the new link from the computer running CAST (', { code: 'bun run pair' }, ').'];
}
