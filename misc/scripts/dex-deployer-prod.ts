import { CrocSwapDex } from "../../typechain/CrocSwapDex";
import { ColdPath } from "../../typechain/ColdPath";
import { WarmPath } from "../../typechain/WarmPath";
import { LongPath } from "../../typechain/LongPath";
import { MicroPaths } from "../../typechain/MicroPaths";
import { CrocPolicy } from "../../typechain/CrocPolicy";
import { CrocQuery } from "../../typechain/CrocQuery";
import { HotPath } from "../../typechain/HotPath";
const hardhat = require("hardhat");
const ethers = hardhat.ethers;
import fs from "fs";
import commandLineArgs from "command-line-args";
import { exit } from "process";
import {
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

// This is a static address which is the EVM address for the module with the name "nativedex"
// It is obtained by taking the first 20 bytes of the keccak256 hash of the string "nativedex", then
// converting that to an EVM address by parsing the address' bytes as an EIP-55 address.
// A convenient way to get this is by using `althea q auth module-account` and using that address with
// `althea debug addr` to get an EVM address.
const nativedexModuleAddress = "0xe3ADB86F7F0425d08ebD0dfFEbd2eEf19E12D30e";

// sets the gas price for all contract deployments
const overrides = {
  //gasPrice: 100000000000
};

// This object holds all the paths to the contract artifacts, which can change depending on the environment.
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

// Collects all the paths to the contract artifacts, which can change depending on the environment.
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

// Actually performs the deploy of all the contracts, then ties them together and configures the DEX for the first pool's creation
// The DEX is a collection of contracts, which are CrocSwapDex (the main contract) and several "callpaths" which are used to get around
// the maximum contract size limit of the EVM. The callpaths are installed via the "BootProxy" callpath (installed in the DEX's constructor).
// This function first deploys all the contracts, then installs them, then sets some required DEX parameters.
// The console log statements are important, they will be detected by the Rust tests and used as the source of contract addresses, so do not change their
// format without careful consideration. See the bootstrapping.rs file for more info.
async function deploy() {
  var startTime = new Date();
  const provider = await new ethers.providers.JsonRpcProvider(args["eth-node"]);
  let wallet = new ethers.Wallet(args["eth-privkey"], provider);
  let artifacts_root = args["artifacts-root"];

  // Attempt to contact the Ethereum node before getting started (timeout after 10 minutes)
  var success = false;
  while (!success) {
    var present = new Date();
    var timeDiff: number = present.getTime() - startTime.getTime();
    timeDiff = timeDiff / 1000;
    provider
      .getBlockNumber()
      .then((_: any) => (success = true))
      .catch((_: any) => console.log("Ethereum RPC error, trying again"));

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

  /*
  // Deploy the CrocSwapDex contract
  ({ abi, bytecode } = getContractArtifacts(contract_paths.dex));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const dex = (await factory.deploy(overrides)) as CrocSwapDex;
  await dex.deployed();
  const dexAddress = dex.address;
  console.log("CrocSwapDex deployed at Address - ", dexAddress);

  // Deploy the HotProxy contract (not installed yet)
  ({ abi, bytecode } = getContractArtifacts(contract_paths.hot));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const hot = (await factory.deploy(overrides)) as HotProxy;
  await hot.deployed();
  const hotAddress = hot.address;
  console.log("HotProxy deployed at Address - ", hotAddress);

  // Deploy the ColdPath contract (not installed yet)
  ({ abi, bytecode } = getContractArtifacts(contract_paths.cold));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const cold = (await factory.deploy(overrides)) as ColdPath;
  await cold.deployed();
  const coldAddress = cold.address;
  console.log("ColdPath deployed at Address - ", coldAddress);

  // Deploy the WarmPath contract (not installed yet)
  ({ abi, bytecode } = getContractArtifacts(contract_paths.warm));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const warm = (await factory.deploy(overrides)) as WarmPath;
  await warm.deployed();
  const warmAddress = warm.address;
  console.log("WarmPath deployed at Address - ", warmAddress);

  // Deploy the LongPath contract (not installed yet)
  ({ abi, bytecode } = getContractArtifacts(contract_paths.long));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const long = (await factory.deploy(overrides)) as LongPath;
  await long.deployed();
  const longAddress = long.address;
  console.log("LongPath deployed at Address - ", longAddress);

  // Deploy the MicroPaths contract (not installed yet)
  ({ abi, bytecode } = getContractArtifacts(contract_paths.micro));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const micro = (await factory.deploy(overrides)) as MicroPaths;
  await micro.deployed();
  const microAddress = micro.address;
  console.log("MicroPaths deployed at Address - ", microAddress);

  // Deploy the KnockoutFlagPath contract (not installed yet)
  ({ abi, bytecode } = getContractArtifacts(contract_paths.knockout_flag));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const knockout_flag = (await factory.deploy(overrides)) as KnockoutFlagPath;
  await knockout_flag.deployed();
  const knockout_flagAddress = knockout_flag.address;
  console.log(
    "KnockoutFlagPath deployed at Address - ",
    knockout_flagAddress
  );
  */

  const dexAddress = "0xd263DC98dEc57828e26F69bA8687281BA5D052E0"
  const hotAddress = "0x254f1A4786eEEdF46cDC065a8A59214812CDA7a3";
  const coldAddress = "0xAb23986c3d2F24EFd823bB8684aFF03A87De6b3C";
  const warmAddress = "0x64A817A34F3c178258FaB793286f229aD54855f5";
  const longAddress = "0xe18D57A1f1c843182e876A1C10A1380C30032c0d";
  const microAddress = "0x98057e5f5e8cF65cd033a1Cc5D58c16a0c897005";
  const knockout_flagAddress = "0x7b9B118f6467c5fc56406c0e74AB705d444fd0e1";

  // Start connection code
  let dex = (await ethers.getContractAt(
    "CrocSwapDex",
    dexAddress,
    wallet
  )) as CrocSwapDex;
  ({ abi, bytecode } = getContractArtifacts(contract_paths.dex));

  if ((await dex.getDeployedCode()) == null) {
    console.error("DEX NOT DEPLOYED???");
    process.exit(1);
  } 
  console.log("Discovered DEX at Address - ", dexAddress);

  let hot = (await ethers.getContractAt(
      "HotProxy",
    hotAddress,
    wallet
  )) as HotProxy;
  if ((await hot.getDeployedCode()) == null) {
    console.error("HotProxy NOT DEPLOYED???");
    process.exit(1);
  }
  console.log("Discovered HotProxy at Address - ", hotAddress);

  let cold = (await ethers.getContractAt(
    "ColdPath",
    coldAddress,
    wallet
  )) as ColdPath;
  if ((await cold.getDeployedCode()) == null) {
    console.error("ColdPath NOT DEPLOYED???");
    process.exit(1);
  }
  console.log("Discovered ColdPath at Address - ", coldAddress);

  let warm = (await ethers.getContractAt(
    "WarmPath",
    warmAddress,
    wallet
  )) as WarmPath;
  if ((await warm.getDeployedCode()) == null) {
    console.error("WarmPath NOT DEPLOYED???");
    process.exit(1);
  }
  console.log("Discovered WarmPath at Address - ", warmAddress);

  let long = (await ethers.getContractAt(
    "LongPath",
    longAddress,
    wallet
  )) as LongPath;
  if ((await long.getDeployedCode()) == null) {
    console.error("LongPath NOT DEPLOYED???");
    process.exit(1);
  }
  console.log("Discovered LongPath at Address - ", longAddress);

  let micro = (await ethers.getContractAt(
    "MicroPaths",
    microAddress,
    wallet
  )) as MicroPaths;
  if ((await micro.getDeployedCode()) == null) {
    console.error("MicroPaths NOT DEPLOYED???");
    process.exit(1);
  }
  console.log("Discovered MicroPaths at Address - ", microAddress);

  let knockout_flag = (await ethers.getContractAt(
    "KnockoutFlagPath",
    knockout_flagAddress,
    wallet
  )) as KnockoutFlagPath;
  if ((await knockout_flag.getDeployedCode()) == null) {
    console.error("KnockoutFlagPath NOT DEPLOYED???");
    process.exit(1);
  }
  console.log("Discovered KnockoutFlagPath at Address - ", knockout_flagAddress);
  // end connection code

  // Deploy the KnockoutLiqPath contract (not installed yet)
  ({ abi, bytecode } = getContractArtifacts(contract_paths.knockout_liq));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const knockout_liq = (await factory.deploy(overrides)) as KnockoutLiqPath;
  await knockout_liq.deployed();
  const knockout_liqAddress = knockout_liq.address;
  console.log("KnockoutLiqPath deployed at Address - ", knockout_liqAddress);

  // Deploy the SafeModePath contract (not installed yet)
  ({ abi, bytecode } = getContractArtifacts(contract_paths.safe_mode));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const safe_mode = (await factory.deploy(overrides)) as SafeModePath;
  await safe_mode.deployed();
  const safe_modeAddress = safe_mode.address;
  console.log("SafeModePath deployed at Address - ", safe_modeAddress);

  // Deploy the governance contract "CrocPolicy", which does not yet control the DEX
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

  // Deploy the CrocQuery periphery contract, which is not directly connected to the DEX
  ({ abi, bytecode } = getContractArtifacts(contract_paths.query));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const query = (await factory.deploy(dexAddress, overrides)) as CrocQuery;
  await query.deployed();
  const queryAddress = query.address;
  console.log("CrocQuery deployed at Address - ", queryAddress);

  // Deploy the CrocImpact periphery contract, which is not directly connected to the DEX
  ({ abi, bytecode } = getContractArtifacts(contract_paths.impact));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const impact = (await factory.deploy(dexAddress, overrides)) as CrocImpact;
  await impact.deployed();
  const impactAddress = impact.address;
  console.log("CrocImpact deployed at Address - ", impactAddress);

  // // Deploy a test upgrade contract, this is a copy of the ColdPath contract which requires that
  // // it will be installed on callpath 33. See the DEX_UPGRADE test for more.
  // ({ abi, bytecode } = getContractArtifacts(contract_paths.upgrade_test));
  // factory = new ethers.ContractFactory(abi, bytecode, wallet);
  // const upgrade = (await factory.deploy(overrides)) as ColdPathUpgrade;
  // await upgrade.deployed();
  // const upgradeAddress = upgrade.address;
  // console.log("ColdPathUpgrade deployed at Address - ", upgradeAddress);


  // Now that all the contracts have been deployed, they must be connected to the main CrocSwapDex contract
  // by calling the BootPath contract's protocolCmd function.
  console.log("Installing CrocSwap contracts");

  let abiCoder = new ethers.utils.AbiCoder();
  let cmd;
  let tx;

  // These are hardcoded values pulled from the solidity contracts, see mixins/StorageLayout.sol for the source values
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
  // Install ColdPath in callpath 3
  cmd = abiCoder.encode(
    ["uint8", "address", "uint16"],
    [21, coldAddress, COLD_PROXY_IDX]
  );
  tx = await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);
  await tx.wait();

  // Install LongPath in callpath 4
  console.log("Installing LongPath");
  cmd = abiCoder.encode(
    ["uint8", "address", "uint16"],
    [21, longAddress, LONG_PROXY_IDX]
  );
  tx = await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);
  await tx.wait();

  // Install WarmPath in callpath 2
  console.log("Installing WarmPath");
  cmd = abiCoder.encode(
    ["uint8", "address", "uint16"],
    [21, warmAddress, LP_PROXY_IDX]
  );
  tx = await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);
  await tx.wait();

  // Install HotProxy in callpath 1
  console.log("Installing HotPath Proxy");
  cmd = abiCoder.encode(
    ["uint8", "address", "uint16"],
    [21, hotAddress, SWAP_PROXY_IDX]
  );
  tx = await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);
  await tx.wait();

  // Install MicroPaths in callpath 5
  console.log("Installing MicroPaths");
  cmd = abiCoder.encode(
    ["uint8", "address", "uint16"],
    [21, microAddress, MICRO_PROXY_IDX]
  );
  tx = await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);
  await tx.wait();

  // Install KnockoutLiqPath in callpath 7
  console.log("Installing KnockoutLiqPath");
  cmd = abiCoder.encode(
    ["uint8", "address", "uint16"],
    [21, knockout_liqAddress, KNOCKOUT_LP_PROXY_IDX]
  );
  tx = await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);
  await tx.wait();

  // Install KnockoutFlagPath in callpath 3500
  console.log("Installing KnockoutFlagPath");
  cmd = abiCoder.encode(
    ["uint8", "address", "uint16"],
    [21, knockout_flagAddress, FLAG_CROSS_PROXY_IDX]
  );
  tx = await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);
  await tx.wait();

  // Install SafeModePath in callpath 9999
  console.log("Installing SafeModePath");
  cmd = abiCoder.encode(
    ["uint8", "address", "uint16"],
    [21, safe_modeAddress, SAFE_MODE_PROXY_PATH]
  );
  tx = await dex.protocolCmd(BOOT_PROXY_IDX, cmd, true);
  await tx.wait();

  // Note we do not install the ColdPathUpgrade since it's use is at test runtime

  // Next we must set some required initial parameters for the DEX.
  // The initial pool liquidity is an amount of tokens which must be provided on every pool creation,
  // and that liquidity must forever be locked into the DEX. This provides a minimum amount of liquidity to make sure that
  // the math all works out in the future even if a pool is "empty".
  console.log("Setting initial pool liquidity");
  let setPoolLiqCmd = abiCoder.encode(["uint8", "uint128"], [112, 1]);
  tx = await dex.protocolCmd(3, setPoolLiqCmd, true);
  await tx.wait();

  // Next we set up two "pool templates", which restrict new pools to adhere to a common format.
  // Regular users are allowed to create new pools with any token pair they want, but they are limited to using only
  // the configured pool templates to control the pool parameters. DEX Governance is allowed to change the templates,
  // change individual pools, and add new templates - but regular users are not able to do so.
  // We set up one pool template for stable-stable token pairs and another for volatile-volatile token pairs.

  /* A pool template consists of:
      PoolIdx: A unique ID which will forever identify pools created using this template
      FeeRate: The fee rate charged on trades, in basis points (1/100th of a percent) - fees are split between LPers and the protocol
      TickSize: The minimum price movement allowed in the pool, in log_2(ticks) - a tick is 1/10000th of a percent and this value
                is actually the exponent so 3 would be 2^3 = 8 ticks. A lower tick size will cause more gas consumption when swapping
                across large price movements, so it's a tradeoff between precision and gas cost.
      JITTime: The amount of time in seconds that a LPer must wait between minting a concentrated position and burning it. This is a 
               means to discourage concentrated position sandwich attacks where one LPer tries to earn all the fees by observing swaps,
               manipulating blocks (possibly via collusion) and sandwiching swaps with a concentrated mint and burn. By not having this
               value set then ambient (full range) LPers will have their rewards diluted by the sandwicher (sandwitch?) while still suffering
               Impermanent Loss. Such a situation would be toxic and lead to poor ambient liquidity in the ecosystem.
      KnockoutBits: Configuration for knockout liquidity, see below
      OracleFlags: Flags for configuring an oracle contract, not used in this deployment. Currently the DEX allows either "permissioned" or
                   "non-permissioned" pools. Permissioned pools require an oracle to be set and the oracle contract will be called to approve or deny
                   actions on permissioned pools including new pool creation, minting, burning, and swapping. All our pools are non-permissioned.
  */

  /* Setting the knockout bits is a bit complicated, from the KnockoutLiq comments:
      The fields are set in the following order from most to least significant bit:
              [8]             [7]            [6][5]          [4][3][2][1]
             Unusued      On-Grid Flag      PlaceType         OrderWidth
                 
      The field types are as follows:
        OrderWidth - The width of new knockout pivots in ticks represented by
                      power of two. 
        PlaceType - Restricts where new knockout pivots can be placed 
                    relative to curve price. Uses the following codes:
              0 - Disabled. No knockout pivots allowed.
              1 - Knockout bids (asks) must be placed with upper (lower) tick
                  below (above) the current curve price.
              2 - Knockout bids (asks) must be placed with lower (upper) tick
                  below (above) the current curve price.

        On-Grid Flag - If set requires that any new knockout range order can only
                      be placed on a tick index that's a multiple of the width. 
                      Can be used to restrict density of knockout orders, beyond 
                      the normal pool tick size.
  */
  let onGridBits = 1 << 7;
  let stablePairWidthBits = 6; // 2^6 = 64 ticks, 1.0001^64 => ~64 basis points of price movement (or 0.6 cents)
  let volatilePairWidthBits = 7; // 2^7 = 128 ticks, 1.0001^128 => ~128 basis points of price movement (or 1%)
  let inRangeKnockoutPlaceType = 2;
  let outOfRangeKnockoutPlaceType = 1;
  let inRangePlaceBits = inRangeKnockoutPlaceType << 4;
  let outOfRangePlaceBits = outOfRangeKnockoutPlaceType << 4;
  
  // Allow pools on the stable pair template to have any knockout position with width of 64 ticks
  let stablePairBits = stablePairWidthBits | inRangePlaceBits | outOfRangePlaceBits;
  // Allow pools on the volatile pair template to have any knockout position with width of 1024 ticks
  let volatilePairBits = volatilePairWidthBits | inRangePlaceBits | outOfRangePlaceBits;


  console.log("Setting default pool templates (index 36000, 36001)");
  // Set the stable pairs to use index 36000, have a fee of 0.5%, tick size of 1, 60 second jit time, stable pair bits, and no oracle
  // Note that the fee is specified in hundredths of a basis point, so 50 basis points is 5000
  let templateCmd = abiCoder.encode(
    ["uint8", "uint256", "uint16", "uint16", "uint8", "uint8", "uint8"],
    [110, 36000, 5000, 1, 60, stablePairBits, 0]
  );
  tx = await dex.protocolCmd(3, templateCmd, false);
  await tx.wait();
  // Set the volatile pairs to use index 36001, have a fee of 1%, tick size of 4, 60 second jit time, volatile pair bits, and no oracle
  // Note that the fee is specified in hundredths of a basis point, so 100 basis points is 10000
  templateCmd = abiCoder.encode(
    ["uint8", "uint256", "uint16", "uint16", "uint8", "uint8", "uint8"],
    [110, 36001, 10000, 2, 60, volatilePairBits, 0]
  );
  tx = await dex.protocolCmd(3, templateCmd, false);
  await tx.wait();
  // On blast the template 420 (used widely) is schema 1, fee rate 1500, protocol take 0, tick size 4, jit thresh 1, knockout bits 34, oracle flags 0
  // The schema will be 1 unless the dex has been upgraded and needed new pool schema values
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
