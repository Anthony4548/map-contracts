import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { create, readFromFile, writeToFile, verify, zksyncDeploy } from "../../utils/helper";
let { deploy_contract, getTronContractAt, getDeployerAddress, toETHAddress } = require("../../utils/tron.js");
import { getSigInfo, compare, Multisig } from "../MultsigUtils";

task("nodeV2:deploy", "deploy oracle light node")
    .addOptionalParam("salt", "oracle salt", "", types.string)
    .addParam("chain", "chain id")
    .addOptionalParam("nodeType", "node type", 4, types.int)
    .addOptionalParam("mpt", "mpt address", process.env.MPT_VERIFY, types.string)
    .addOptionalParam("impl", "impl address", "", types.string)
    .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
        const { deployments, network } = hre;
        const { deploy } = deployments;
        let [wallet] = await hre.ethers.getSigners();

        let salt = taskArgs.salt;
        let mpt = taskArgs.mpt;
        let impl = taskArgs.impl;
        let LightNode = await hre.ethers.getContractFactory("LightNodeV2");

        let node;
        if (network.name === "Tron" || network.name === "TronTest") {
            if (mpt === undefined || mpt === "") {
                let result = await deploy_contract(hre.artifacts, "MPTVerify", [], network.name);
                mpt = result[1];
            }
            mpt = await toETHAddress(mpt, network.name);
            console.log("MPT address", mpt);
            if (impl === "") {
                let impl_deploy = await deploy_contract(hre.artifacts, "LightNodeV2", [], network.name);
                impl = impl_deploy[0];
            }
            impl = await toETHAddress(impl, network.name);
            console.log("impl address", impl);

            let impl_param = LightNode.interface.encodeFunctionData("initialize", [
                taskArgs.chain,
                await getDeployerAddress(network.name),
                mpt,
                taskArgs.nodeType,
            ]);
            let proxy_deploy = await deploy_contract(hre.artifacts, "LightNodeProxy", [impl, impl_param], network.name);

            node = proxy_deploy[0];
        } else if (network.config.chainId === 324 || network.config.chainId === 280) {
            if (mpt === undefined || mpt === "") {
                mpt = await zksyncDeploy("MPTVerify", [], hre);
            }
            if (impl === "") {
                impl = await zksyncDeploy("LightNodeV2", [], hre);
            }

            let impl_param = LightNode.interface.encodeFunctionData("initialize", [
                taskArgs.chain,
                wallet.address,
                mpt,
                taskArgs.nodeType,
            ]);
            let proxy_deploy = await zksyncDeploy("LightNodeProxy", [impl, impl_param], hre);
            node = proxy_deploy;
        } else {
            console.log("wallet address is:", wallet.address);
            if (mpt === undefined || mpt === "") {
                let result = await deploy("MPTVerify", {
                    from: wallet.address,
                    args: [],
                    log: true,
                    contract: "MPTVerify",
                });
                mpt = result.address;
            }
            console.log("mpt  address :", mpt);

            let impl_deploy = await deploy("LightNodeV2", {
                from: wallet.address,
                args: [],
                log: true,
                contract: "LightNodeV2",
            });
            impl = impl_deploy.address;
            console.log("impl  address :", impl);

            let impl_param = LightNode.interface.encodeFunctionData("initialize", [
                taskArgs.chain,
                wallet.address,
                mpt,
                taskArgs.nodeType,
            ]);
            if (salt === "") {
                let result = await deploy("LightNodeProxy", {
                    from: wallet.address,
                    args: [impl, impl_param],
                    log: true,
                    contract: "LightNodeProxy",
                });
                node = result.address;
            } else {
                let param = hre.ethers.utils.defaultAbiCoder.encode(["address", "bytes"], [impl, impl_param]);
                let LightNodeProxy = await hre.ethers.getContractFactory("LightNodeProxy");
                let result = await create(salt, LightNodeProxy.bytecode, param, hre.ethers);
                node = result[0];
            }

            const verifyArgs = [taskArgs.chain, wallet.address, mpt, taskArgs.nodeType]
                .map((arg) => (typeof arg == "string" ? `'${arg}'` : arg))
                .join(" ");
            console.log(`To verify, run: npx hardhat verify --network ${network.name} ${impl} ${verifyArgs}`);
            // await verify(
            //     node,
            //     [chainId, wallet.address, mpt,nodeType],
            //     "contracts/LightNode.sol:LightNode",
            //     hre.run
            // );
        }
        console.log("node  address :", node);
        let d = await readFromFile(network.name);
        if (!d.networks[network.name].lightNodes[taskArgs.chain]) {
            d.networks[network.name].lightNodes[taskArgs.chain] = { proxy: "", impl: "" };
        }

        d.networks[network.name].lightNodes[taskArgs.chain].proxy = node;
        d.networks[network.name].lightNodes[taskArgs.chain].impl = impl;
        await writeToFile(d);
    });

task("nodeV2:upgrade", "deploy oracle light node")
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

        if (network.name === "Tron" || network.name === "TronTest") {
            let lightNode = await getTronContractAt(hre.artifacts, "LightNodeV2", node, network.name);
            console.log("old impl :", await lightNode.getImplementation().call());
            let result;
            if (impl === "impl") {
                let impl_deploy = await deploy_contract(hre.artifacts, "LightNodeV2", [], network.name);
                impl = impl_deploy[0];
                result = await lightNode.upgradeTo(impl_deploy[1]).send();
            } else {
                let hexImpl = impl;
                if (!impl.startsWith("0x")) {
                    hexImpl = await toETHAddress(impl, network.name);
                }
                result = await lightNode.upgradeTo(hexImpl).send();
            }
            console.log(result);
            console.log("new impl :", await lightNode.getImplementation().call());
        } else {
            if (impl === "impl") {
                if (network.config.chainId === 324 || network.config.chainId === 280) {
                    impl = await zksyncDeploy("LightNodeV2", [], hre);
                } else {
                    let l = await deploy("LightNodeV2", {
                        from: wallet.address,
                        args: [],
                        log: true,
                        contract: "LightNodeV2",
                    });
                    impl = l.address;
                }
            }

            const LightNode = await hre.ethers.getContractFactory("LightNodeV2");
            let proxy = LightNode.attach(node);
            console.log("old impl :", await proxy.getImplementation());
            await (await proxy.upgradeTo(impl)).wait();
            console.log("new impl :", await proxy.getImplementation());
        }
        d.networks[network.name].lightNodes[chain].impl = impl;

        writeToFile(d);
    });

task("nodeV2:setMptVerify", "set mpt verify address")
    .addOptionalParam("chain", "chainId", 0, types.int)
    .addOptionalParam("node", "light node address", "node", types.string)
    .addParam("mpt", "mpt address")
    .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
        let [wallet] = await hre.ethers.getSigners();
        console.log("wallet address is:", wallet.address);
        const { network } = hre;

        let d = await readFromFile(network.name);

        let chain = taskArgs.chain;
        if (chain == 0) {
            chain = Object.keys(d.networks[network.name].lightNodes)[0];
        }

        let node = taskArgs.node;
        if (node === "node") {
            if (d.networks[network.name].oracle === undefined || d.networks[network.name].oracle === "") {
                throw "oracle not deploy";
            }
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

        if (network.name === "Tron" || network.name === "TronTest") {
            let lightNode = await getTronContractAt(hre.artifacts, "LightNodeV2", node, network.name);
            let old_verify = await lightNode.mptVerify().call();
            console.log("old mptVerify address is :", old_verify);
            let mpt = taskArgs.mpt;
            if (!mpt.startsWith("0x")) {
                mpt = await toETHAddress(mpt, network.name);
            }
            let result = await lightNode.setMptVerify(mpt).send();
            console.log(result);
            let new_verify = await lightNode.mptVerify().call();
            console.log("new mptVerify address is :", new_verify);
        } else {
            const LightNode = await hre.ethers.getContractFactory("LightNodeV2");
            let proxy = LightNode.attach(node);
            let old_verify = await proxy.mptVerify();
            console.log("old mptVerify address is :", old_verify);
            await (await proxy.setMptVerify(taskArgs.mpt)).wait();
            let new_verify = await proxy.mptVerify();
            console.log("new mptVerify address is :", new_verify);
        }
    });

task("nodeV2:setNodeType", "set mpt verify address")
    .addOptionalParam("chain", "chainId", 0, types.int)
    .addOptionalParam("node", "light node address", "node", types.string)
    .addParam("type", "node type, 4 - mpt, 5 - log")
    .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
        let [wallet] = await hre.ethers.getSigners();
        console.log("wallet address is:", wallet.address);
        const { network } = hre;

        let d = await readFromFile(network.name);

        let chain = taskArgs.chain;
        if (chain == 0) {
            chain = Object.keys(d.networks[network.name].lightNodes)[0];
        }

        let node = taskArgs.node;
        if (node === "node") {
            if (d.networks[network.name].oracle === undefined || d.networks[network.name].oracle === "") {
                throw "oracle not deploy";
            }
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

        if (network.name === "Tron" || network.name === "TronTest") {
            let lightNode = await getTronContractAt(hre.artifacts, "LightNodeV2", node, network.name);
            let old_type = await lightNode.nodeType().call();
            console.log("old node type is :", old_type);
            let result = await lightNode.setNodeType(taskArgs.type).send();
            //console.log(result);
            let new_type = await lightNode.nodeType().call();
            console.log("new node type is :", new_type);
        } else {
            const LightNode = await hre.ethers.getContractFactory("LightNodeV2");
            let proxy = LightNode.attach(node);
            console.log("old node type is :", await proxy.nodeType());
            await (await proxy.setNodeType(taskArgs.type)).wait();
            console.log("new node type is :", await proxy.nodeType());
        }
    });

task("nodeV2:updateMultisig", "update multi sign address")
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
        if (network.name === "Tron" || network.name === "TronTest") {
            let lightNode = await getTronContractAt(hre.artifacts, "LightNodeV2", node, network.name);

            let old_info = await lightNode.multisigInfo().call();
            console.log("old_info :", old_info);

            let sig = getSigInfo();

            let d = await compare(old_info.version, sig);
            if (d) {
                console.log("Multisg already set");
            } else {
                let result = await lightNode.updateMultisig(sig.quorum, sig.signers).send();
                console.log("updateMultisg: ", result);
            }
        } else {
            console.log("wallet address is:", wallet.address);
            const LightNode = await hre.ethers.getContractFactory("LightNodeV2");
            let proxy = LightNode.attach(node);

            let old_info = await proxy.multisigInfo();
            console.log("old_info :", old_info);
            let sig = getSigInfo();
            let d = await compare(old_info.version, sig);
            if (d) {
                console.log("Multisg already set");
            } else {
                await (await proxy.updateMultisig(sig.quorum, sig.signers)).wait();
            }
        }
    });
