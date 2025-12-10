import { ethers } from "ethers";
import fs from "fs";
import commandLineArgs from "command-line-args";
import { exit } from "process";
import {
  AltheaDexIncentivesContinuousEpochMulti,
} from "../../typechain";

const args = commandLineArgs([
  // the ethernum node used to deploy the contract
  { name: "eth-node", type: String },
  // the Ethereum private key that will contain the gas required to pay for the contact deployment
  { name: "eth-privkey", type: String },
  // The root path of the artifacts
  { name: "artifacts-root", type: String },
  // the location of the incentives contract
  { name: "contract-json", type: String },
  // the address of the DEX
  { name: "dex-address", type: String },
]);

// This is a static address which is the EVM address for the module with the name "nativedex"
// It is obtained by taking the first 20 bytes of the keccak256 hash of the string "nativedex", then
// converting that to an EVM address by parsing the address' bytes as an EIP-55 address.
// A convenient way to get this is by using `althea q auth module-account` and using that address with
// `althea debug addr` to get an EVM address.
const nativedexModuleAddress = "0xe3ADB86F7F0425d08ebD0dfFEbd2eEf19E12D30e";
const zeroAddress = "0x0000000000000000000000000000000000000000";

// sets the gas price for all contract deployments
const overrides = {
  //gasPrice: 100000000000
};

// Collects all the paths to the contract artifacts, which can change depending on the environment.
function get_path(root: string, include_sol: boolean): string {
  if (include_sol) {
    return root + "AltheaDexIncentivesContinuousEpochMulti.sol/AltheaDexIncentivesContinuousEpochMulti.json";
  }
  return root + "AltheaDexIncentivesContinuousEpochMulti.json";
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
  let dexAddress = args["dex-address"];

  // Attempt to contact the Ethereum node before getting started (timeout after 10 minutes)
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

  console.log("Deploying incentives contract");

  if (!fs.existsSync(artifacts_root)) {
    console.log(
      "The artifacts root path does not exist, please check the path and try again"
    );
    exit(1);
  }
  var contract_path: string = get_path(artifacts_root, true);

  var abi;
  var bytecode;
  var factory;

  // Deploy the CrocSwapDex contract
  ({ abi, bytecode } = getContractArtifacts(contract_path));
  factory = new ethers.ContractFactory(abi, bytecode, wallet);
  let deployTx = await factory.getDeployTransaction(dexAddress, nativedexModuleAddress, overrides);
  let sentTx = await wallet.sendTransaction(deployTx);
  let receipt = await sentTx.wait();
  const incentivesContract = (await factory.attach(receipt.contractAddress)) as AltheaDexIncentivesContinuousEpochMulti;
  await incentivesContract.deployed();
  console.log("AltheaDexIncentivesContinuousEpochMulti deployed at Address - ", receipt.contractAddress);
  console.log("AltheaDexIncentivesContinuousEpochMulti gas used: ", receipt.gasUsed.toString());
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
