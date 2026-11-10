export function gamepadSnapshot(pads: readonly (Gamepad | null)[]) {
  return pads.filter((pad): pad is Gamepad => Boolean(pad?.connected)).map(pad => ({
    index: pad.index, id: pad.id, mapping: pad.mapping,
    buttons: Array.from(pad.buttons, button => ({ pressed: button.pressed, value: button.value })),
    axes: Array.from(pad.axes),
  }));
}
