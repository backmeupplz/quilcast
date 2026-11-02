// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {QuilcastCards} from "../src/QuilcastCards.sol";

contract QuilcastCardsTest is Test {
    QuilcastCards c = new QuilcastCards("https://quilcast.com/nft/card/", "https://quilcast.com/nft/cards.json", address(this));
    address alice = address(0xA11CE);

    function test_aCardIsCollectedOnce() public {
        vm.prank(alice);
        c.collect(3);
        assertEq(c.ownerOf(3), alice);
        assertEq(c.totalSupply(), 1);
        assertEq(c.tokenURI(3), "https://quilcast.com/nft/card/3");
        vm.expectRevert();
        c.collect(3);
    }

    function test_noCardForNoFid() public {
        vm.expectRevert("no such fid");
        c.collect(0);
        vm.expectRevert("no such fid");
        c.collect(uint256(type(uint64).max) + 1);
    }

    function test_onlyOwnerMovesMetadata() public {
        c.setURIs("ipfs://a/", "ipfs://b");
        assertEq(c.contractURI(), "ipfs://b");
        vm.prank(alice);
        vm.expectRevert();
        c.setURIs("x", "y");
        assertTrue(c.supportsInterface(0x49064906) && c.supportsInterface(0x80ac58cd));
    }
}
