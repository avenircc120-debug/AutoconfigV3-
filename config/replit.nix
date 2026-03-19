{ pkgs }:
{
  deps = [
    pkgs.nodejs_20
    pkgs.nodePackages.npm
    pkgs.nodePackages.nodemon
  ];
  env = {
    NODE_ENV = "development";
  };
}
