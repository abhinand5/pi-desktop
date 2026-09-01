/**
 * The reading column.
 *
 * The transcript, the composer, the banner above it, and the status strip below
 * it all have to agree on this. When only the transcript honoured the width
 * setting, turning on the wide column left the composer narrower than the text
 * it belongs to and visibly off-centre against it.
 */
export function columnWidth(wide: boolean): string {
  return wide ? "max-w-[980px]" : "max-w-[760px]";
}
