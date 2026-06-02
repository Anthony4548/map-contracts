import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { getSigInfo, compare, Multisig } from "../MultsigUtils";
import { create, readFromFile, writeToFile, verify } from "../../utils/helper";

task("oracleV3:deploy", "deploy oracle")
    .addOptionalParam("salt", "oracle salt", "", types.string)
    .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
        let [wallet] = await hre.ethers.getSigners();
        const { deployments, network } = hre;
        const { deploy } = deployments;
        let salt = taskArgs.salt;
        console.log("wallet address is:", wallet.address);
        let Oracle = await hre.ethers.getContractFactory("contracts/v3/OracleV3.sol:OracleV3");
        let impl = await Oracle.deploy();
        await impl.deployed();

        let OracleProxy = await hre.ethers.getContractFactory("OracleProxy");
        let impl_param = Oracle.interface.encodeFunctionData("initialize", [
            wallet.address
        ]);
        let param = hre.ethers.utils.defaultAbiCoder.encode(["address", "bytes"], [impl.address, impl_param]);
        let result = await create(salt, OracleProxy.bytecode, param, hre.ethers);
        let oracle = result[0];
        console.log("oracle deploy to :", oracle);
        const verifyArgs = [wallet.address];
        let d = await readFromFile(hre.network.name);
        d.networks[network.name].oracle = oracle;
        await writeToFile(d);

        try {
            await verify(impl.address, [], "contracts/v3/OracleV3.sol:OracleV3", hre.run);
            console.log("verified oracle impl:", impl.address);
        } catch (error) {
            console.log("verify oracle impl failed:", error);
        }

        try {
            await verify(oracle, [impl.address, impl_param], "contracts/OracleProxy.sol:OracleProxy", hre.run);
            console.log("verified oracle proxy:", oracle);
        } catch (error) {
            console.log("verify oracle proxy failed:", error);
        }
    });

task("oracleV3:upgrade", "deploy oracle")
    .addOptionalParam("oracle", "oracle proxy address", "oracle", types.string)
    .addOptionalParam("impl", "oracle impl address", "impl", types.string)
    .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
        let [wallet] = await hre.ethers.getSigners();
        const { deployments, network } = hre;
        const { deploy } = deployments;
        console.log("wallet address is:", wallet.address);

        let d = await readFromFile(hre.network.name);
        let oracleAddr = taskArgs.oracle;
        if (oracleAddr === "oracle") {
            if (d.networks[network.name].oracle === undefined || d.networks[network.name].oracle === "") {
                throw "oracle not deploy";
            }
            oracleAddr = d.networks[network.name].oracle;
        }
        console.log("oracle proxy:", oracleAddr);

        let impl = taskArgs.impl;
        if (impl === "impl") {
            let deployed = await deploy("OracleV3", {
                from: wallet.address,
                args: [],
                log: true,
                contract: "contracts/v3/OracleV3.sol:OracleV3",
            });
            impl = deployed.address;

            try {
                await verify(impl, [], "contracts/v3/OracleV3.sol:OracleV3", hre.run);
                console.log("verified oracle impl:", impl);
            } catch (error) {
                console.log("verify oracle impl failed:", error);
            }
        }
        const Oracle = await hre.ethers.getContractFactory("contracts/v3/OracleV3.sol:OracleV3");
        let oracle = Oracle.attach(oracleAddr);
        console.log("old impl :", await oracle.getImplementation());
        await (await oracle.upgradeTo(impl)).wait();
        console.log("new impl :", await oracle.getImplementation());

        try {
            await verify(oracleAddr, [impl, "0x"], "contracts/OracleProxy.sol:OracleProxy", hre.run);
            console.log("verify oracle proxy attempt finished:", oracleAddr);
        } catch (error) {
            console.log("verify oracle proxy failed:", error);
        }
        d.networks[network.name].oracle = oracleAddr;
        await writeToFile(d);
    });

task("oracleV3:updateMultisig", "set light node address")
    .addOptionalParam("oracle", "oracle address", "", types.string)
    .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
        let [wallet] = await hre.ethers.getSigners();
        const { network } = hre;
        let d = await readFromFile(network.name);

        let oracleAddr = taskArgs.oracle;
        if (oracleAddr === "") {
            if (d.networks[network.name].oracle === undefined || d.networks[network.name].oracle === "") {
                throw "oracle not deploy";
            }
            oracleAddr = d.networks[network.name].oracle;
        }
        console.log("oracle manager address:", oracleAddr);
        console.log("wallet address is:", wallet.address);
        const Oracle = await hre.ethers.getContractFactory("contracts/v3/OracleV3.sol:OracleV3");
        let oracle = Oracle.attach(oracleAddr);
        let old_info = await oracle.multisigInfo();
        console.log("old_info :", old_info);
        let sig = getSigInfo();
        let c = await compare(old_info.version, sig);
        if (c) {
            console.log("Multisg already set");
        } else {
            await (await oracle.updateMultisig(sig.quorum, sig.signers)).wait();
        }
    });


task("oracleV3:removeProposal", "remove oracle proposal")
    .addOptionalParam("oracle", "oracle address", "", types.string)
    .addOptionalParam("chainid", "chain id", "", types.string)
    .addOptionalParam("block", "block number", "", types.string)
    .addOptionalParam("txIndex", "transaction index", "", types.string)
    .addOptionalParam("logIndex", "log index", "", types.string)
    .addOptionalParam("position", "packed position", "", types.string)
    .addOptionalParam("signer", "proposal signer", "", types.string)
    .addOptionalParam("index", "signature index", "", types.string)
    .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
        let [wallet] = await hre.ethers.getSigners();
        const { network } = hre;
        let d = await readFromFile(network.name);

        let oracleAddr = taskArgs.oracle;
        if (oracleAddr === "") {
            if (d.networks[network.name].oracle === undefined || d.networks[network.name].oracle === "") {
                throw "oracle not deploy";
            }
            oracleAddr = d.networks[network.name].oracle;
        }
        console.log("oracle manager address:", oracleAddr);
        console.log("wallet address is:", wallet.address);
        const Oracle = await hre.ethers.getContractFactory("contracts/v3/OracleV3.sol:OracleV3");
        let oracle = Oracle.attach(oracleAddr);
        let position;
        if (taskArgs.position !== "") {
            position = taskArgs.position;
        } else {
            if (taskArgs.block === "" || taskArgs.txIndex === "" || taskArgs.logIndex === "") {
                throw "need position or block + txIndex + logIndex";
            }
            position = await oracle.encodePosition(taskArgs.block, taskArgs.txIndex, taskArgs.logIndex);
        }
        let rst = await oracle.recoverProposal(taskArgs.chainid, position, taskArgs.signer, taskArgs.index);
    });

task("oracleV3:grantRole", "set token outFee")
    .addOptionalParam("oracle", "oracle address", "", types.string)
    .addParam("role", "role address")
    .addParam("account", "account address")
    .addOptionalParam("grant", "grant or revoke", true, types.boolean)
    .setAction(async (taskArgs, hre) => {
        let [wallet] = await hre.ethers.getSigners();
        const { network } = hre;
        let d = await readFromFile(network.name);

        let oracleAddr = taskArgs.oracle;
        if (oracleAddr === "") {
            if (d.networks[network.name].oracle === undefined || d.networks[network.name].oracle === "") {
                throw "oracle not deploy";
            }
            oracleAddr = d.networks[network.name].oracle;
        }
        console.log("oracle manager address:", oracleAddr);
        console.log("wallet address is:", wallet.address);
        const Oracle = await hre.ethers.getContractFactory("contracts/v3/OracleV3.sol:OracleV3");
        let oracle = Oracle.attach(oracleAddr);
  
        let role;
        if (taskArgs.role === "upgrade" || taskArgs.role === "upgrader") {
            role = await oracle.UPGRADER_ROLE();
        } else if (taskArgs.role === "manage" || taskArgs.role === "manager") {
            role = await oracle.MANAGER_ROLE();
        } else if (taskArgs.role === "pause" || taskArgs.role === "pauser") {
            role = await oracle.PAUSER_ROLE();
        } else {
            role = hre.ethers.constants.HashZero;
        }
    
        if (taskArgs.grant) {
            await (await oracle.grantRole(role, taskArgs.account)).wait();
            console.log(`grant ${taskArgs.account} role ${role}`);
        } else {
            await oracle.revokeRole(role, taskArgs.account);
            console.log(`revoke ${taskArgs.account} role ${role}`);
        }
    });

