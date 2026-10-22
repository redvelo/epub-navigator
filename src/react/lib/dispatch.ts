/**
 * Runs a coordinator command that reports its outcome through that coordinator's snapshot.
 *
 * The returned promise is not the reporting channel, so a rejection means the coordinator failed
 * in a way it could not describe. Letting it escape would surface a defect as an unhandled
 * rejection in the host, which is not the reader's to raise.
 */
export function dispatchCommand(command: Promise<unknown> | undefined): void {
  void command?.catch(() => {});
}
