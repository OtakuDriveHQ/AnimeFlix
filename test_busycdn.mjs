async function testBusycdn() {
  const busycdnUrl = "https://instant.busycdn.xyz/6a389727a1c35400f2b1cb6bb827bd65e92e503dac25a6dfb273e397a3025f4a0a1e15ad97fb97d0c7e91f1e44e032ae4938b10ca8d70095fb50308aa9f9dc2109934ad0a20590ac1ecbaa93c2e46cdc57d577f8a44fa2617aa63335886efcb094d479be7d404f9ae67faf78497dd1dc::432c091b6dc65c176aff7770331374ce?bytes=167484546";

  console.log("Testing busycdn with redirect: manual...");
  const t0 = Date.now();
  try {
    const res = await fetch(busycdnUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "text/html,*/*;q=0.8",
        "Referer": "https://new4.gdflix.io/",
      },
      redirect: "manual",
    });
    console.log("Status:", res.status, "took", Date.now() - t0, "ms");
    console.log("Location header:", res.headers.get("location"));
  } catch (e) {
    console.error("Error:", e.message);
  }
}

testBusycdn();
