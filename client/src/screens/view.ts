export interface View {
  readonly element: HTMLElement
  update(frame: import('../api/types.ts').RoomFrame): void
  destroy(): void
}
