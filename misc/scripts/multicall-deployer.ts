import { Multicall3 } from "../../typechain/";
import { ethers } from "ethers";
import fs from "fs";
import commandLineArgs from "command-line-args";
import { exit } from "process";

const args = commandLineArgs([
  // the ethernum node used to deploy the contract
  { name: "eth-node", type: String },
  // the Ethereum private key that will contain the gas required to pay for the contact deployment
  { name: "eth-privkey", type: String },
]);

const nativedexModuleAddress = "0xe3ADB86F7F0425d08ebD0dfFEbd2eEf19E12D30e";

// sets the gas price for all contract deployments
const overrides = {
  //gasPrice: 100000000000
};


function get_path(root: string, include_sol: boolean): string {
  if (include_sol) {
    return root + "Multicall3.sol/Multicall3.json" ;
  }
  return root + "Multicall3.json";
}

async function deploy() {
  var startTime = new Date();
  const provider = await new ethers.providers.JsonRpcProvider(args["eth-node"]);
  let wallet = new ethers.Wallet(args["eth-privkey"], provider);
  const testMode = args["test-mode"] == "True" || args["test-mode"] == "true";

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

    console.log("Deploying ERC20 contract");

    // this handles several possible locations for the ERC20 artifacts
    var contract_path: string;
    const root_main = "/althea/solidity-dex/artifacts/contracts/periphery/";
    const main_location_a = root_main + "Multicall3.sol/Multicall3.json";

    const root_alt_1 = "/solidity-dex/periphery/";
    const alt_location_1_a = root_alt_1 + "Multicall3.json";

    const alt_location_2_a = "Multicall3.json";

    var contract_path: string;
    if (fs.existsSync(main_location_a)) {
      contract_path = get_path(root_main, true);
    } else if (fs.existsSync(alt_location_1_a)) {
      contract_path = get_path(root_alt_1, false);
    } else if (fs.existsSync(alt_location_2_a)) {
      contract_path = get_path("", false);
    } else {
      console.log(
        "Contract can't be found!"
      );
      exit(1);
    }

    var abi;
    var bytecode;
    var factory;

    console.log("Deploying Multicall3 contract");

    ({ abi, bytecode } = getContractArtifacts(contract_path));
    factory = new ethers.ContractFactory(abi, bytecode, wallet);
    const multicall = (await factory.deploy(overrides)) as Multicall3;
    await multicall.deployed();
    const multicallAddress = multicall.address;
    console.log("Multicall3 deployed at Address - ", multicallAddress);

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

