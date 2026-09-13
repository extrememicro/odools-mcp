export const RUNTIME_SCHEMA = 1;
export const RUNTIME_VERSION = "1.5.2";
export const RUNTIME_CHANNEL = "beta";
export const RUNTIME_TAG = "1.5.2";
export const RUNTIME_COMMIT = "ec189919c30ab0ece0d63410695e6a49d891a821";
export const TYPESCRIPT_VERSION = "6.0.2";
export const TYPESCRIPT_INTEGRITY = "sha512-bGdAIrZ0wiGDo5l8c++HWtbaNCWTS4UTv7RaTH/ThVIgjkveJt83m74bBHMJkuCbslY8ixgLBVZJIOiQlQTjfQ==";

export interface AssetSpec {
  name: string;
  url: string;
  sha256: string;
  size: number;
}

export interface RuntimeSpec {
  platform: "linux";
  arch: "x64";
  odools: AssetSpec;
  typeshed: AssetSpec;
  typescript: AssetSpec & { integrity: string };
}

export const LINUX_X64_SPEC: RuntimeSpec = {
  platform: "linux",
  arch: "x64",
  odools: {
    name: "odoo-linux-x86_64-1.5.2.tar.gz",
    url: "https://github.com/odoo/odoo-ls/releases/download/1.5.2/odoo-linux-x86_64-1.5.2.tar.gz",
    sha256: "ffcd3cfdab27c0f91ace832aa578ab18dddbe8f45b6a85e72e9f0f9a205edb1d",
    size: 7_595_989,
  },
  typeshed: {
    name: "typeshed.zip",
    url: "https://github.com/odoo/odoo-ls/releases/download/1.5.2/typeshed.zip",
    sha256: "45066263a6e01f114fb46079da21c5474f2fda80d9c77da5272edb5170e73ef3",
    size: 8_929_917,
  },
  typescript: {
    name: "typescript-6.0.2.tgz",
    url: "https://registry.npmjs.org/typescript/-/typescript-6.0.2.tgz",
    sha256: "0ae5c188a2f5db22df72fe5e74dcbc122afb52031a86dbac33e78a86db39c65e",
    size: 4_515_770,
    integrity: TYPESCRIPT_INTEGRITY,
  },
};

export function runtimeSpec(platform: string = process.platform, arch: string = process.arch): RuntimeSpec {
  if (platform !== "linux" || arch !== "x64") {
    throw new Error(`Unsupported runtime platform: ${platform}/${arch}`);
  }
  return LINUX_X64_SPEC;
}
