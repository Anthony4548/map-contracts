import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { create, readFromFile, writeToFile } from "../../utils/helper";
import { getSigInfo, compare } from "../MultsigUtils";

task("nodeV3:deploy", "deploy oracle light node v3")
    .addOptionalParam("salt", "oracle salt", "", types.string)
    .addParam("chain", "chain id")
    .addOptionalParam("impl", "impl address", "", types.string)
    .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
        const { deployments, network } = hre;
        const { deploy } = deployments;
        let [wallet] = await hre.ethers.getSigners();

        let salt = taskArgs.salt;
        let impl = taskArgs.impl;
        let LightNode = await hre.ethers.getContractFactory("LightNodeV3");

        let node;
        console.log("wallet address is:", wallet.address);
        if (impl === "") {
            let implDeploy = await deploy("LightNodeV3", {
                from: wallet.address,
                args: [],
                log: true,
                contract: "LightNodeV3",
            });
            impl = implDeploy.address;
        }
        console.log("impl address :", impl);

        let implParam = LightNode.interface.encodeFunctionData("initialize", [taskArgs.chain, wallet.address]);
        if (salt === "") {
            let result = await deploy("LightNodeProxy", {
                from: wallet.address,
                args: [impl, implParam],
                log: true,
                contract: "LightNodeProxy",
            });
            node = result.address;
        } else {
            let param = hre.ethers.utils.defaultAbiCoder.encode(["address", "bytes"], [impl, implParam]);
            let LightNodeProxy = await hre.ethers.getContractFactory("LightNodeProxy");
            let result = await create(salt, LightNodeProxy.bytecode, param, hre.ethers);
            node = result[0];
        }

        console.log("node address :", node);
        let d = await readFromFile(network.name);
        if (!d.networks[network.name].lightNodes[taskArgs.chain]) {
            d.networks[network.name].lightNodes[taskArgs.chain] = { proxy: "", impl: "" };
        }

        d.networks[network.name].lightNodes[taskArgs.chain].proxy = node;
        d.networks[network.name].lightNodes[taskArgs.chain].impl = impl;
        await writeToFile(d);
    });

task("nodeV3:upgrade", "upgrade oracle light node v3")
    .addOptionalParam("chain", "chainId", 0, types.int)
    .addOptionalParam("node", "light node address", "node", types.string)
    .addOptionalParam("impl", "impl address", "impl", types.string)
    .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
        let [wallet] = await hre.ethers.getSigners();
        console.log("wallet address is:", wallet.address);
        const { deployments, network } = hre;
        const { deploy } = deployments;

        let d = await readFromFile(network.name);
        let chain = taskArgs.chain;
        if (chain == 0) {
            chain = Object.keys(d.networks[network.name].lightNodes)[0];
        }

        let impl = taskArgs.impl;
        let node = taskArgs.node;

        if (node === "node") {
            if (!d.networks[network.name].lightNodes[chain]) {
                throw "oracle light node not deploy";
            }
            if (
                d.networks[network.name].lightNodes[chain].proxy === undefined ||
                d.networks[network.name].lightNodes[chain].proxy === ""
            ) {
                throw "oracle light node not deploy";
            }
            node = d.networks[network.name].lightNodes[chain].proxy;
        }
        console.log("light node proxy: ", node);

        if (impl === "impl") {
            let deployed = await deploy("LightNodeV3", {
                from: wallet.address,
                args: [],
                log: true,
                contract: "LightNodeV3",
            });
            impl = deployed.address;
        }

        const LightNode = await hre.ethers.getContractFactory("LightNodeV3");
        let proxy = LightNode.attach(node);
        console.log("old impl :", await proxy.getImplementation());
        await (await proxy.upgradeTo(impl)).wait();
        console.log("new impl :", await proxy.getImplementation());

        d.networks[network.name].lightNodes[chain].impl = impl;
        await writeToFile(d);
    });

task("nodeV3:updateMultisig", "update multi sign address for light node v3")
    .addOptionalParam("chain", "chainId", 0, types.int)
    .addOptionalParam("node", "light node address", "node", types.string)
    .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
        let [wallet] = await hre.ethers.getSigners();
        const { network } = hre;

        let d = await readFromFile(network.name);
        let chain = taskArgs.chain;
        if (chain == 0) {
            chain = Object.keys(d.networks[network.name].lightNodes)[0];
        }
        console.log("light node chain id:", chain);

        let node = taskArgs.node;
        if (node === "node") {
            if (!d.networks[network.name].lightNodes[chain]) {
                throw "oracle light node not deploy";
            }
            if (
                d.networks[network.name].lightNodes[chain].proxy === undefined ||
                d.networks[network.name].lightNodes[chain].proxy === ""
            ) {
                throw "oracle light node not deploy";
            }
            node = d.networks[network.name].lightNodes[chain].proxy;
        }
        console.log("light node address:", node);

        const LightNode = await hre.ethers.getContractFactory("LightNodeV3");
        let proxy = LightNode.attach(node);

        let oldInfo = await proxy.multisigInfo();
        console.log("oldInfo :", oldInfo);
        let sig = getSigInfo();
        let same = await compare(oldInfo.version, sig);
        if (same) {
            console.log("Multisg already set");
        } else {
            await (await proxy.updateMultisig(sig.quorum, sig.signers)).wait();
        }
    });
