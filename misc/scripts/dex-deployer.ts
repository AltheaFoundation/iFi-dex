import { CrocSwapDex } from "../../typechain/CrocSwapDex";
import { ColdPath } from "../../typechain/ColdPath";
import { WarmPath } from "../../typechain/WarmPath";
import { LongPath } from "../../typechain/LongPath";
import { MicroPaths } from "../../typechain/MicroPaths";
import { CrocPolicy } from "../../typechain/CrocPolicy";
import { CrocQuery } from "../../typechain/CrocQuery";
import { HotPath } from "../../typechain/HotPath";
import { ethers } from "ethers";
import fs from "fs";
import commandLineArgs from "command-line-args";
import { exit } from "process";
import {
  ColdPathUpgrade,
  CrocImpact,
  HotProxy,
  KnockoutFlagPath,
  KnockoutLiqPath,
  SafeModePath,
} from "../../typechain";

const args = commandLineArgs([
  // the ethernum node used to deploy the contract
  { name: "eth-node", type: String },
  // the Ethereum private key that will contain the gas required to pay for the contact deployment
  { name: "eth-privkey", type: String },
  // The root path of the artifacts
  { name: "artifacts-root", type: String },
  // the location of the crocswap dex contract
  { name: "contract-json", type: String },
]);

const nativedexModuleAddress = "0xe3ADB86F7F0425d08ebD0dfFEbd2eEf19E12D30e";

// sets the gas price for all contract deployments
const overrides = {
  //gasPrice: 100000000000
};

type CrocPaths = {
  dex: string;
  hot: string;
  cold: string;
  warm: string;
  long: string;
  micro: string;
  knockout_flag: string;
  knockout_liq: string;
  safe_mode: string;
  policy: string;
  query: string;
  impact: string;
  upgrade_test: string;
};

function get_paths(root: string, include_sol: boolean): CrocPaths {
  if (include_sol) {
    return {
      dex: root + "CrocSwapDex.sol/CrocSwapDex.json",
      hot: root + "callpaths/HotPath.sol/HotProxy.json",
      cold: root + "callpaths/ColdPath.sol/ColdPath.json",
      warm: root + "callpaths/WarmPath.sol/WarmPath.json",
      long: root + "callpaths/LongPath.sol/LongPath.json",
      micro: root + "callpaths/MicroPaths.sol/MicroPaths.json",
      knockout_flag: root + "callpaths/KnockoutPath.sol/KnockoutFlagPath.json",
      knockout_liq: root + "callpaths/KnockoutPath.sol/KnockoutLiqPath.json",
      safe_mode: root + "callpaths/SafeModePath.sol/SafeModePath.json",
      policy: root + "governance/CrocPolicy.sol/CrocPolicy.json",
      query: root + "lens/CrocQuery.sol/CrocQuery.json",
      impact: root + "lens/CrocImpact.sol/CrocImpact.json",
      upgrade_test: root + "test/ColdPathUpgrade.sol/ColdPathUpgrade.json",
    };
  }
  return {
    dex: root + "CrocSwapDex.json",
    hot: root + "HotProxy.json",
    cold: root + "ColdPath.json",
    warm: root + "WarmPath.json",
    long: root + "LongPath.json",
    micro: root + "MicroPaths.json",
    knockout_flag: root + "KnockoutFlagPath.json",
    knockout_liq: root + "KnockoutLiqPath.json",
    safe_mode: root + "SafeModePath.json",
    policy: root + "CrocPolicy.json",
    query: root + "CrocQuery.json",
    impact: root + "CrocImpact.json",
    upgrade_test: root + "ColdPathUpgrade.json",
  };
}

async function deploy() {
  var startTime = new Date();
  const provider = await new ethers.providers.JsonRpcProvider(args["eth-node"]);
  let wallet = new ethers.Wallet(args["eth-privkey"], provider);
  let artifacts_root = args["artifacts-root"];

  var success = false;
  while (!success) {
    var present = new Date();
    var timeDiff: number = present.getTime() - startTime.getTime();
    timeDiff = timeDiff / 1000;
    provider
      .getBlockNumber()
      .then((_) => (success = true))
      .catch((_) => console.log("Ethereum RPC error, trying again"));

    if (timeDiff > 600) {
      console.log(
        "Could not contact Ethereum RPC after 10 minutes, check the URL!"
      );
      exit(1);
    }
    await sleep(1000);
  }

  console.log("Deploying Crocswap/Ambient contracts");

  if (!fs.existsSync(artifacts_root)) {
    console.log(
      "The artifacts root path does not exist, please check the path and try again"
    );
    exit(1);
  }
  var contract_paths: CrocPaths = get_paths(artifacts_root, true);

  var abi;
  var bytecode;
  var factory;

  ({ abi, bytecode } = getContractArtifacts(contract_paths.dex));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const dex = (await factory.deploy(overrides)) as CrocSwapDex;
  await dex.deployed();
  const dexAddress = dex.address;
  console.log("CrocSwapDex deployed at Address - ", dexAddress);

  ({ abi, bytecode } = getContractArtifacts(contract_paths.hot));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const hot = (await factory.deploy(overrides)) as HotProxy;
  await hot.deployed();
  const hotAddress = hot.address;
  console.log("HotProxy deployed at Address - ", hotAddress);

  ({ abi, bytecode } = getContractArtifacts(contract_paths.cold));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const cold = (await factory.deploy(overrides)) as ColdPath;
  await cold.deployed();
  const coldAddress = cold.address;
  console.log("ColdPath deployed at Address - ", coldAddress);

  ({ abi, bytecode } = getContractArtifacts(contract_paths.warm));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const warm = (await factory.deploy(overrides)) as WarmPath;
  await warm.deployed();
  const warmAddress = warm.address;
  console.log("WarmPath deployed at Address - ", warmAddress);

  ({ abi, bytecode } = getContractArtifacts(contract_paths.long));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const long = (await factory.deploy(overrides)) as LongPath;
  await long.deployed();
  const longAddress = long.address;
  console.log("LongPath deployed at Address - ", longAddress);

  ({ abi, bytecode } = getContractArtifacts(contract_paths.micro));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const micro = (await factory.deploy(overrides)) as MicroPaths;
  await micro.deployed();
  const microAddress = micro.address;
  console.log("MicroPaths deployed at Address - ", microAddress);

  ({ abi, bytecode } = getContractArtifacts(contract_paths.knockout_flag));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const knockout_flag = (await factory.deploy(overrides)) as KnockoutFlagPath;
  await knockout_flag.deployed();
  const knockout_flagAddress = knockout_flag.address;
  console.log(
    "KnockoutFlagPath deployed at Address - ",
    knockout_flagAddress
  );

  ({ abi, bytecode } = getContractArtifacts(contract_paths.knockout_liq));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const knockout_liq = (await factory.deploy(overrides)) as KnockoutLiqPath;
  await knockout_liq.deployed();
  const knockout_liqAddress = knockout_liq.address;
  console.log("KnockoutLiqPath deployed at Address - ", knockout_liqAddress);

  ({ abi, bytecode } = getContractArtifacts(contract_paths.safe_mode));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const safe_mode = (await factory.deploy(overrides)) as SafeModePath;
  await safe_mode.deployed();
  const safe_modeAddress = safe_mode.address;
  console.log("SafeModePath deployed at Address - ", safe_modeAddress);

  ({ abi, bytecode } = getContractArtifacts(contract_paths.policy));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const policy = (await factory.deploy(
    dexAddress,
    nativedexModuleAddress,
    overrides
  )) as CrocPolicy;
  await policy.deployed();
  const policyAddress = policy.address;
  console.log("CrocPolicy deployed at Address - ", policyAddress);

  ({ abi, bytecode } = getContractArtifacts(contract_paths.query));

  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const query = (await factory.deploy(dexAddress, overrides)) as CrocQuery;
  await query.deployed();
  const queryAddress = query.address;
  console.log("CrocQuery deployed at Address - ", queryAddress);

  ({ abi, bytecode } = getContractArtifacts(contract_paths.impact));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const impact = (await factory.deploy(dexAddress, overrides)) as CrocImpact;
  await impact.deployed();
  const impactAddress = impact.address;
  console.log("CrocImpact deployed at Address - ", impactAddress);

  ({ abi, bytecode } = getContractArtifacts(contract_paths.upgrade_test));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const upgrade = (await factory.deploy(overrides)) as ColdPathUpgrade;
  await upgrade.deployed();
  const upgradeAddress = upgrade.address;
  console.log("ColdPathUpgrade deployed at Address - ", upgradeAddress);

  console.log("Installing CrocSwap contracts");

  let abiCoder = new ethers.utils.AbiCoder();
  let cmd;
  let tx;

  const BOOT_PROXY_IDX = 0;
  const SWAP_PROXY_IDX = 1;
  const LP_PROXY_IDX = 2;
  const COLD_PROXY_IDX = 3;
  const LONG_PROXY_IDX = 4;
  const MICRO_PROXY_IDX = 5;
  const KNOCKOUT_LP_PROXY_IDX = 7;
  const FLAG_CROSS_PROXY_IDX = 3500;
  const SAFE_MODE_PROXY_PATH = 9999;

  // use protocolCmd to install paths
  // install coldpath
  cmd = abiCoder.encode(
    ["uint8", "address", "uint16"],
    [21, coldAddress, COLD_PROXY_IDX]
  );
  tx = await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);
  await tx.wait();

  // // install longpath
  console.log("Installing LongPath");
  cmd = abiCoder.encode(
    ["uint8", "address", "uint16"],
    [21, longAddress, LONG_PROXY_IDX]
  );
  tx = await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);
  await tx.wait();

  // // install warm path
  console.log("Installing WarmPath");
  cmd = abiCoder.encode(
    ["uint8", "address", "uint16"],
    [21, warmAddress, LP_PROXY_IDX]
  );
  tx = await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);
  await tx.wait();

  // // install hot proxy path
  console.log("Installing HotPath Proxy");
  cmd = abiCoder.encode(
    ["uint8", "address", "uint16"],
    [21, hotAddress, SWAP_PROXY_IDX]
  );
  tx = await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);
  await tx.wait();

  // // install micro paths
  console.log("Installing MicroPaths");
  cmd = abiCoder.encode(
    ["uint8", "address", "uint16"],
    [21, microAddress, MICRO_PROXY_IDX]
  );
  tx = await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);
  await tx.wait();

  // // install knockout lp proxy path
  console.log("Installing KnockoutLiqPath");
  cmd = abiCoder.encode(
    ["uint8", "address", "uint16"],
    [21, knockout_liqAddress, KNOCKOUT_LP_PROXY_IDX]
  );
  tx = await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);
  await tx.wait();

  // // install cross knockout cross proxy path
  console.log("Installing KnockoutFlagPath");
  cmd = abiCoder.encode(
    ["uint8", "address", "uint16"],
    [21, knockout_flagAddress, FLAG_CROSS_PROXY_IDX]
  );
  tx = await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);
  await tx.wait();

  // // install safe mode path
  console.log("Installing SafeModePath");
  cmd = abiCoder.encode(
    ["uint8", "address", "uint16"],
    [21, safe_modeAddress, SAFE_MODE_PROXY_PATH]
  );
  tx = await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);
  await tx.wait();

  // Note we do not install the ColdPathUpgrade since it's use is at test runtime

  console.log("Setting initial pool liquidity");
  let setPoolLiqCmd = abiCoder.encode(["uint8", "uint128"], [112, 1]);
  tx = await dex.protocolCmd(3, setPoolLiqCmd, true);
  await tx.wait();
  console.log("Setting default pool templates (index 36000, 36001)");
  let templateCmd = abiCoder.encode(
    ["uint8", "uint256", "uint16", "uint16", "uint8", "uint8", "uint8"],
    [110, 36000, 100, 1, 8, 32 + 6, 0]
  );
  tx = await dex.protocolCmd(3, templateCmd, false);
  await tx.wait();
  templateCmd = abiCoder.encode(
    ["uint8", "uint256", "uint16", "uint16", "uint8", "uint8", "uint8"],
    [110, 36001, 100, 1, 8, 32 + 6, 0]
  );
  tx = await dex.protocolCmd(3, templateCmd, false);
  await tx.wait();
}

function getContractArtifacts(path: string): { bytecode: string; abi: string } {
  var { bytecode, abi } = JSON.parse(fs.readFileSync(path, "utf8").toString());
  return { bytecode, abi };
}

async function main() {
  await deploy();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main();
