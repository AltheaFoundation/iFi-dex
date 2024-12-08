/**
 * @type import('hardhat/config').HardhatUserConfig
 */

import { HardhatUserConfig, vars } from "hardhat/config";
import "hardhat-typechain";
import "@nomiclabs/hardhat-ethers";
import "hardhat-contract-sizer";
import "@nomicfoundation/hardhat-verify";

require("hardhat-storage-layout");
require("solidity-coverage");
// The following are set using `npx hardhat vars set <KEY>` and then the value is a prompt for a secret.
// I provide a default value so that the call does not fail for regular hardhat network usage
const DAI_PRIVATE_KEY = vars.get(
  "DAI_PRIVATE_KEY",
  "0xc5e8f61d1ab959b397eecc0a37a6517b8e67a0e7cf1f4bce5591f3ed80199122" // hardhat signer 0 to avoid failure
);
const DAI_TEST1 = vars.get(
  "DAI_TEST1",
  "0xd49743deccbccc5dc7baa8e69e5be03298da8688a15dd202e20f15d5e0e9a9fb" // hardhat signer 1 to avoid failure
);
const DAI_TEST2 = vars.get(
  "DAI_TEST2",
  "0x23c601ae397441f3ef6f1075dcb0031ff17fb079837beadaf3c84d96c6f3e569" // hardhat signer 2 to avoid failure
);
const DAI_TEST3 = vars.get(
  "DAI_TEST3",
  "0xee9d129c1997549ee09c0757af5939b2483d80ad649a0eda68e8b0357ad11131" // hardhat signer 3 to avoid failure
);
const DAI_TEST4 = vars.get(
  "DAI_TEST4",
  "0x87630b2d1de0fbd5044eb6891b3d9d98c34c8d310c852f98550ba774480e47cc" // hardhat signer 4 to avoid failure
);
const DAI_TEST5 = vars.get(
  "DAI_TEST5",
  "0x275cc4a2bfd4f612625204a20a2280ab53a6da2d14860c47a9f5affe58ad86d4" // hardhat signer 5 to avoid failure
);
const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: {
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 1000000,
          },
          outputSelection: {
            "*": {
              "*": ["storageLayout"],
            },
          },
        },
      },
    ],
    overrides: {},
  },

  networks: {
    local: {
      url: "http://localhost:8545",
      chainId: 6633438,
      accounts: [
        "0x3b23c86080c9abc8870936b2eb17ecb808f5ad3b318018b3e23873013379e4d6",
        "0xa9c7120f7a13a0bb0b0c513e6145bc1e4c55a126a055da53c5e7612d25aca8c7",
        "0x3f4eeb27124d1fcf9bffa1bc2bfa4660f75777dbfc268f0349636e429105aa7f",
        "0x5791240cd5798ecf4862be2c1c1ae882b80a804e7a3fc615a93910c554b23115",
        "0x34d97aaf58b1a81d3ed3068a870d8093c6341cf5d1ef7e6efa03fe7f7fc2c3a8",
      ],
    },
    gnosis: {
      url: "https://rpc.gnosischain.com",
      accounts: [
        DAI_PRIVATE_KEY,
        DAI_TEST1,
        DAI_TEST2,
        DAI_TEST3,
        DAI_TEST4,
        DAI_TEST5,
      ],
    },
  },
};

export default config;
