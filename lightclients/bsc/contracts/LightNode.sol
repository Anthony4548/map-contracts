// SPDX-License-Identifier: MIT

pragma solidity 0.8.7;

import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@mapprotocol/protocol/contracts/interface/ILightNode.sol";
import "./lib/Verify.sol";

contract LightNode is UUPSUpgradeable, Initializable, Pausable, ILightNode {
    uint256 internal constant EPOCH_NUM = 200;

    uint256 internal constant MAX_SAVED_EPOCH_NUM = 12960;

    uint256 internal constant ADDRESS_LENGTH = 20;

    address public mptVerify;

    uint256 public chainId;

    uint256 public minValidBlocknum;

    uint256 public minEpochBlockExtraDataLen;

    mapping(uint256 => bytes) public validators;

    uint256 internal _lastSyncedBlock;

    address private _pendingAdmin;

    mapping(uint256 => bytes32) private cachedReceiptRoot;

    event ChangePendingAdmin(address indexed previousPending, address indexed newPending);
    event SetMptVerify(address newMptVerify);

    event AdminTransferred(address indexed previous, address indexed newAdmin);

    struct ProofData {
        Verify.BlockHeader[] headers;
        Verify.ReceiptProof receiptProof;
    }

    modifier onlyOwner() {
        require(msg.sender == _getAdmin(), "lightnode :: only admin");
        _;
    }

    constructor() {}

    function initialize(
        uint256 _chainId,
        uint256 _minEpochBlockExtraDataLen,
        address _controller,
        address _mptVerify,
        Verify.BlockHeader[2] calldata _headers
    ) external initializer {
        require(chainId == 0, "already initialized");
        require(_chainId > 0, "_chainId is zero");
        require(_minEpochBlockExtraDataLen > 0, "_minEpochBlockExtraDataLen is zero");
        require(_controller != address(0), "_controller zero address");
        require(_mptVerify != address(0), "_mptVerify zero address");
        mptVerify = _mptVerify;
        _changeAdmin(_controller);
        chainId = _chainId;
        minEpochBlockExtraDataLen = _minEpochBlockExtraDataLen;

        _initBlock(_headers);
    }

    function togglePause(bool _flag) external onlyOwner returns (bool) {
        if (_flag) {
            _pause();
        } else {
            _unpause();
        }

        return true;
    }

    function setMptVerify(address _newMptVerify) external onlyOwner {
        require(_newMptVerify.code.length > 0, "_newMptVerify must contract address");
        mptVerify = _newMptVerify;
        emit SetMptVerify(_newMptVerify);
    }

    function updateBlockHeader(bytes memory _blockHeadersBytes) external override whenNotPaused {
        Verify.BlockHeader[] memory _blockHeaders = abi.decode(_blockHeadersBytes, (Verify.BlockHeader[]));
        require(_lastSyncedBlock > 0, "light node uninitialized");
        _lastSyncedBlock += EPOCH_NUM;

        require(_blockHeaders[0].number == _lastSyncedBlock, "invalid start block");
        // min is number of validators half + 1
        uint256 min = _getValidatorNum(validators[_lastSyncedBlock - EPOCH_NUM]) / 2 + 1;

        require(_blockHeaders.length >= min, "proof headers not enough");

        (bool result, string memory message) = _verifyBlockHeaders(_blockHeaders, min);

        require(result, message);

        validators[_lastSyncedBlock] = Verify._getValidators(
            chainId,
            _blockHeaders[0].number,
            _blockHeaders[0].extraData
        );

        _removeExcessEpochValidators();

        emit UpdateBlockHeader(tx.origin, _blockHeaders[0].number);
    }

    function verifyProofData(
        bytes memory _receiptProof
    ) external view override returns (bool success, string memory message, bytes memory logs) {
        ProofData memory proof = abi.decode(_receiptProof, (ProofData));

        Verify.BlockHeader[] memory headers = proof.headers;

        return _verifyProofData(proof, headers);
    }

    function verifyProofData(
        uint256 _logIndex,
        bytes memory _receiptProof
    ) external view override returns (bool success, string memory message, txLog memory log) {
    }

    function verifyProofDataWithCache(
        bytes memory _receiptProof
    ) external override returns (bool success, string memory message, bytes memory logs) {
        ProofData memory proof = abi.decode(_receiptProof, (ProofData));
        Verify.BlockHeader[] memory headers = proof.headers;

        uint256 verifyBlockNum = headers[0].number;
        bytes32 receiptRoot = cachedReceiptRoot[verifyBlockNum];
        if (cachedReceiptRoot[verifyBlockNum] != bytes32("")) {
            (success, logs) = Verify._validateProof(receiptRoot, proof.receiptProof, mptVerify);
            if (!success) {
                message = "mpt verification failed";
            }
        } else {
            (success, message, logs) = _verifyProofData(proof, headers);
            if (success) cachedReceiptRoot[verifyBlockNum] = bytes32(headers[0].receiptsRoot);
        }
    }

    function verifyProofDataWithCache(
        bool _cache,
        uint256 _logIndex,
        bytes memory _receiptProof
    ) external override returns (bool success, string memory message, txLog memory log) {

    }

    function _verifyProofData(
        ProofData memory proof,
        Verify.BlockHeader[] memory headers
    ) private view returns (bool success, string memory message, bytes memory logs) {
        require(
            minValidBlocknum > 0 &&
                headers[0].number >= minValidBlocknum &&
                headers[headers.length - 1].number <= maxCanVerifyNum(),
            "Out of verify range"
        );
        // min is number of min validators half + 1
        uint256 min;
        {
            uint256 beyond = headers[0].number % EPOCH_NUM;
            uint256 recently = headers[0].number - beyond;
            min = _getValidatorNum(validators[recently - EPOCH_NUM]) / 2 + 1;
        }
        require(headers.length >= min, "proof headers not enough");

        (success, message) = _verifyBlockHeaders(headers, min);

        if (success) {
            bytes32 rootHash = bytes32(headers[0].receiptsRoot);
            (success, logs) = Verify._validateProof(rootHash, proof.receiptProof, mptVerify);

            if (!success) {
                message = "mpt verification failed";
            }
        }
    }

    function _initBlock(Verify.BlockHeader[2] memory _headers) internal {
        require(_lastSyncedBlock == 0, "already init");

        require(_headers[0].number + EPOCH_NUM == _headers[1].number);

        for (uint256 i = 0; i < 2; i++) {
            require(_headers[i].number % EPOCH_NUM == 0, "invalid init block number");
            require(_headers[i].extraData.length >= minEpochBlockExtraDataLen, "invalid init block");
            validators[_headers[i].number] = Verify._getValidators(chainId, _headers[i].number, _headers[i].extraData);
        }

        minValidBlocknum = _headers[1].number;

        _lastSyncedBlock = _headers[1].number;
    }

    function _verifyBlockHeaders(
        Verify.BlockHeader[] memory _blockHeaders,
        uint256 _min
    ) internal view returns (bool, string memory) {
        // address[] memory miners = new address[](_blockHeaders.length);

        uint256 start = _blockHeaders[0].number;

        uint256 preGasLimt = _blockHeaders[0].gasLimit;

        uint256 preBlockTime;
        bytes memory vals;
        uint256 vNum;
        for (uint256 i = 0; i < _min; i++) {
            if (_blockHeaders[i].number != start + i) {
                return (false, "invalid block number");
            }

            if (i > 0) {
                if (_blockHeaders[i].timestamp <= preBlockTime) {
                    return (false, "invalid block time");
                }
            }

            preBlockTime = _blockHeaders[i].timestamp;
            if (!Verify._validateHeader(_blockHeaders[i], preGasLimt, minEpochBlockExtraDataLen)) {
                return (false, "invalid block");
            }
            preGasLimt = _blockHeaders[i].gasLimit;
            uint256 mod = (_blockHeaders[i].number % EPOCH_NUM);
            uint256 recently = _blockHeaders[i].number - mod;
            vals = validators[recently - EPOCH_NUM];
            vNum = _getValidatorNum(vals);
            if (!Verify._containsValidator(vals,_blockHeaders[i].miner, _blockHeaders[i].number % vNum)) {
                if(mod > 10) {
                    vals = validators[recently];
                    vNum = _getValidatorNum(vals);
                    if(!Verify._containsValidator(vals, _blockHeaders[i].miner, _blockHeaders[i].number % (vNum))){
                        return (false, "invalid signer");
                    }
                } else {
                    return (false, "invalid signer");
                }
            }

            if (!Verify._verifyHeaderSignature(_blockHeaders[i], chainId)) {
                return (false, "invalid Signature");
            }
        }

        return (true, "");
    }

    // function _isRepeat(address[] memory _miners, address _miner, uint256 _limit) private pure returns (bool) {
    //     for (uint256 i = 0; i < _limit; i++) {
    //         if (_miners[i] == _miner) {
    //             return true;
    //         }
    //     }

    //     return false;
    // }

    function _removeExcessEpochValidators() internal {
        if (_lastSyncedBlock > EPOCH_NUM * MAX_SAVED_EPOCH_NUM) {
            uint256 remove = _lastSyncedBlock - EPOCH_NUM * MAX_SAVED_EPOCH_NUM;

            if (remove + EPOCH_NUM > minValidBlocknum && validators[remove].length > 0) {
                uint256 bond = _getValidatorNum(validators[remove]) / 2 + 1;
                minValidBlocknum = remove + EPOCH_NUM + bond;
                delete validators[remove];
            }
        }
    }

    function _getValidatorNum(bytes memory _validators) private pure returns (uint256) {
        return _validators.length / ADDRESS_LENGTH;
    }

    function getBytes(ProofData calldata _proof) external pure returns (bytes memory) {
        return abi.encode(_proof);
    }

    function getHeadersBytes(Verify.BlockHeader[] calldata _blockHeaders) external pure returns (bytes memory) {
        return abi.encode(_blockHeaders);
    }

    function headerHeight() external view override returns (uint256) {
        return _lastSyncedBlock;
    }

    function maxCanVerifyNum() public view returns (uint256) {
        return _lastSyncedBlock + EPOCH_NUM + _getValidatorNum(validators[_lastSyncedBlock]) / 2;
    }

    function verifiableHeaderRange() external view override returns (uint256, uint256) {
        return (minValidBlocknum, maxCanVerifyNum());
    }

    function notifyLightClient(address _from, bytes memory _data) external override {
        emit ClientNotifySend(_from, block.number, _data);
    }

    function isVerifiable(uint256 _blockHeight, bytes32) external view override returns (bool) {
        return minValidBlocknum <= _blockHeight && _blockHeight <= maxCanVerifyNum();
    }

    function nodeType() external view override returns (uint256) {
        // return this chain light node type on target chain
        // 1 default light client
        // 2 zk light client
        // 3 oracle client
        return 1;
    }

    function updateLightClient(bytes memory) external pure override {}

    function clientState() external pure override returns (bytes memory) {}

    function finalizedState(bytes memory) external pure override returns (bytes memory) {}

    /** UUPS *********************************************************/
    function _authorizeUpgrade(address) internal view override {
        require(msg.sender == _getAdmin(), "LightNode: only Admin can upgrade");
    }

    function changeAdmin() external {
        require(_pendingAdmin == msg.sender, "only pendingAdmin");
        emit AdminTransferred(_getAdmin(), _pendingAdmin);
        _changeAdmin(_pendingAdmin);
    }

    function pendingAdmin() external view returns (address) {
        return _pendingAdmin;
    }

    function setPendingAdmin(address pendingAdmin_) external onlyOwner {
        require(pendingAdmin_ != address(0), "Ownable: pendingAdmin is the zero address");
        emit ChangePendingAdmin(_pendingAdmin, pendingAdmin_);
        _pendingAdmin = pendingAdmin_;
    }

    function getAdmin() external view returns (address) {
        return _getAdmin();
    }

    function getImplementation() external view returns (address) {
        return _getImplementation();
    }
}
