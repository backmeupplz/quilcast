// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// farcaster.xyz's Network School vote (FarcasterOptIn on Base): one soulbound token per fid.
interface IOptIn {
    function minted(uint256 fid) external view returns (bool);
}

/// "I receded my vote": a free sticker for fids that voted for the Network School Farcaster client.
/// Their vote token is soulbound and only farcaster.xyz can revoke it, so this is the public take-back.
contract QuilcastRecede is ERC1155, Ownable {
    string public constant name = "I receded my vote";
    string public constant symbol = "QCRECEDE";
    uint256 public constant STICKER = 1;

    IOptIn public immutable optIn;
    string public contractURI;
    uint256 public totalSupply;
    mapping(address => bool) public receded;

    event Receded(uint256 indexed fid, address indexed by);
    event ContractURIUpdated();

    constructor(IOptIn optIn_, string memory uri_, string memory contractURI_, address owner_) ERC1155(uri_) Ownable(owner_) {
        optIn = optIn_;
        contractURI = contractURI_;
    }

    /// Mints the sticker to the caller for a fid holding a live vote token. Once per wallet.
    // ponytail: fid ownership isn't proven on Base (custody lives on OP), the mini app passes the viewer's own fid;
    // add a Quilcast-signed SIWF authorization if people start receding other fids.
    function recede(uint256 fid) external {
        require(optIn.minted(fid), "no vote to recede");
        require(!receded[msg.sender], "already receded");
        receded[msg.sender] = true;
        totalSupply++;
        emit Receded(fid, msg.sender);
        _mint(msg.sender, STICKER, 1, "");
    }

    /// Lets the metadata move (e.g. to IPFS) without a new contract.
    function setURIs(string calldata uri_, string calldata contractURI_) external onlyOwner {
        _setURI(uri_);
        contractURI = contractURI_;
        emit URI(uri_, STICKER);
        emit ContractURIUpdated();
    }
}
