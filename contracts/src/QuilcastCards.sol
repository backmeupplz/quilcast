// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// Quilcast Cards: every Farcaster profile has one trading card, collected once, for free, as a 1/1. The token id is
/// the profile's FID, so a card is found without an index, and its metadata lives at baseURI + "<fid>". The picture
/// is the profile as it was when the card was collected (kept by quilcast.com).
contract QuilcastCards is ERC721, Ownable {
    string public baseURI;
    string public contractURI;
    uint256 public totalSupply;

    event Collected(uint256 indexed fid, address indexed by);
    event ContractURIUpdated();
    /// ERC-4906, so marketplaces refetch every token's metadata when it moves
    event BatchMetadataUpdate(uint256 fromTokenId, uint256 toTokenId);

    constructor(string memory baseURI_, string memory contractURI_, address owner_)
        ERC721("Quilcast Cards", "QCARD")
        Ownable(owner_)
    {
        baseURI = baseURI_;
        contractURI = contractURI_;
    }

    /// Mints the profile's card to the caller; reverts once someone has it. FIDs start at 1 and fit in 64 bits.
    function collect(uint256 fid) external {
        require(fid != 0 && fid <= type(uint64).max, "no such fid");
        totalSupply++;
        _mint(msg.sender, fid);
        emit Collected(fid, msg.sender);
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return string.concat(baseURI, Strings.toString(id));
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
