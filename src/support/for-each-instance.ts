/** What a walk reads from one of Nest's `InstanceWrapper`s. Duck-typed on purpose. */
export interface InstanceWrapperLike {
  token?: unknown;
  name?: unknown;
  instance?: unknown;
  metatype?: unknown;
  isAlias?: boolean;
  isDependencyTreeStatic?(): boolean;
}

/** What a walk reads from one of Nest's `Module`s. */
export interface ContainerModuleLike {
  /** The same id the serialized graph gives the module's node. */
  id?: string;
  name?: string;
  providers?: Map<unknown, InstanceWrapperLike>;
  controllers?: Map<unknown, InstanceWrapperLike>;
  injectables?: Map<unknown, InstanceWrapperLike>;
}

/** What a walk reads from Nest's `ModulesContainer`. */
export interface ContainerLike {
  values(): Iterable<ContainerModuleLike>;
}

export type WrapperCollection = 'providers' | 'controllers' | 'injectables';

/**
 * Visits every wrapper of the given collections in every module, aliases (`useExisting`) left
 * out, with or without a live instance (`REQUEST`-scoped classes have none).
 */
export function forEachInstance(
  container: ContainerLike,
  collections: readonly WrapperCollection[],
  visit: (wrapper: InstanceWrapperLike, module: ContainerModuleLike) => void,
): void {
  for (const module of container.values()) {
    for (const collection of collections) {
      for (const wrapper of module[collection]?.values() ?? []) {
        if (!wrapper.isAlias) visit(wrapper, module);
      }
    }
  }
}
