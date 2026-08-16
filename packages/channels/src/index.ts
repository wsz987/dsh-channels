/**
 * @wsz987/dsh-channels — DSH Bundle and Web host entry.
 *
 * Official Harness bundles expose the plugin modules referenced by their own
 * patch. The package root is the Web host entry so Harness can also discover
 * this package's dsh.client declaration.
 */
export * from '@wsz987/channel-web';
