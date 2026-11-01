// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// Quilcast Collect: every Farcaster cast can be collected once, for free, as a 1/1. The token id is the cast's
/// 20-byte hash, so the cast's NFT is found without an index, and its metadata lives at baseURI + "0x<hash>".
contract QuilcastCollect is ERC721, Ownable {
    string public baseURI;
    string public contractURI;
    uint256 public totalSupply;

    event Collected(bytes20 indexed cast, address indexed by);
    event ContractURIUpdated();
    /// ERC-4906, so marketplaces refetch every token's metadata when it moves
    event BatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId);

    constructor(string memory baseURI_, string memory contractURI_, address owner_)
        ERC721("Quilcast Collect", "QCAST")
        Ownable(owner_)
    {
        baseURI = baseURI_;
        contractURI = contractURI_;
    }

    /// Mints the cast to the caller; reverts once someone has it.
    function collect(bytes20 cast) external {
        totalSupply++;
        _mint(msg.sender, uint160(cast));
        emit Collected(cast, msg.sender);
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return string.concat(baseURI, Strings.toHexString(id, 20));
    }

    function supportsInterface(bytes4 id) public view override returns (bool) {
        return id == 0x49064906 || super.supportsInterface(id);
    }

    /// Lets the metadata move (e.g. to IPFS) without a new contract.
    function setURIs(string calldata baseURI_, string calldata contractURI_) external onlyOwner {
        baseURI = baseURI_;
        contractURI = contractURI_;
        emit BatchMetadataUpdate(0, type(uint256).max);
        emit ContractURIUpdated();
    }
}
