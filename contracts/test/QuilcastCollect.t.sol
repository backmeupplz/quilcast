// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {QuilcastCollect} from "../src/QuilcastCollect.sol";

contract QuilcastCollectTest is Test {
    QuilcastCollect c = new QuilcastCollect("https://quilcast.com/nft/", "https://quilcast.com/nft/collection.json", address(this));
    address alice = address(0xA11CE);
    bytes20 cast = bytes20(hex"00ab000000000000000000000000000000000c0d");

    function test_aCastIsCollectedOnce() public {
        vm.prank(alice);
        c.collect(cast);
        assertEq(c.ownerOf(uint160(cast)), alice);
        assertEq(c.totalSupply(), 1);
        assertEq(c.tokenURI(uint160(cast)), "https://quilcast.com/nft/0x00ab000000000000000000000000000000000c0d");
        vm.expectRevert();
        c.collect(cast);
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
