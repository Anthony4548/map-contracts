import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { getSigInfo, compare, Multisig } from "../MultsigUtils";
import { create, readFromFile, writeToFile, zksyncDeploy, verify } from "../../utils/helper";

task("oracleV3:deploy", "deploy oracle")
    .addOptionalParam("salt", "oracle salt", "", types.string)
    .setAction(async (taskArgs, hre: HardhatRuntimeEnvironment) => {
        let [wallet] = await hre.ethers.getSigners();
        const { deployments, network } = hre;
        const { deploy } = deployments;
        let salt = taskArgs.salt;
        console.log("wallet address is:", wallet.address);
        let Oracle = await hre.ethers.getContractFactory("OracleV3");
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
        const verifyArgs = [wallet.address].map((arg) => (typeof arg == "string" ? `'${arg}'` : arg)).join(" ");
        console.log(`To verify, run: npx hardhat verify --network ${hre.network.name} ${oracle} ${verifyArgs}`);
        let d = await readFromFile(hre.network.name);
        d.networks[network.name].oracle = oracle;
        await writeToFile(d);
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
                contract: "OracleV3",
            });
            impl = deployed.address;
        }
        const Oracle = await hre.ethers.getContractFactory("OracleV3");
        let oracle = Oracle.attach(oracleAddr);
        console.log("old impl :", await oracle.getImplementation());
        await (await oracle.upgradeTo(impl)).wait();
        console.log("new impl :", await oracle.getImplementation());
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
        const Oracle = await hre.ethers.getContractFactory("OracleV3");
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


task("oracleV3:removeProposal", "set light node address")
    .addOptionalParam("oracle", "oracle address", "", types.string)
    .addOptionalParam("chainid", "oracle address", "", types.string)
    .addOptionalParam("block", "oracle address", "", types.string)
    .addOptionalParam("txIndex", "transaction index", "", types.string)
    .addOptionalParam("logIndex", "log index", "", types.string)
    .addOptionalParam("position", "packed position", "", types.string)
    .addOptionalParam("signer", "oracle address", "", types.string)
    .addOptionalParam("index", "oracle address", "", types.string)
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
        const Oracle = await hre.ethers.getContractFactory("OracleV3");
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
        const Oracle = await hre.ethers.getContractFactory("OracleV3");
        let oracle = Oracle.attach(oracleAddr);
  
        let role;
        if (taskArgs.role === "upgrade" || taskArgs.role === "upgrader") {
            role = hre.ethers.utils.keccak256(hre.ethers.utils.toUtf8Bytes("UPGRADER_ROLE"));
        } else if (taskArgs.role === "manage" || taskArgs.role === "manager") {
            role = hre.ethers.utils.keccak256(hre.ethers.utils.toUtf8Bytes("MANAGER_ROLE"));
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

